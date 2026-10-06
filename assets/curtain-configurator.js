/**
 * <curtain-configurator>
 *
 * Made-to-measure curtain configurator for the Dawn theme.
 *
 * Flow: the customer types a width and picks a drop + fabric. it find the
 * pricing tier for that width, calculate the price, select the matching
 * pre-priced variant and add it to the cart via the Ajax Cart API.
 *
 * All business data (tiers, limits, prices, option values) comes from the
 * JSON block rendered by sections/curtain-configurator.liquid. Only the
 * shape of the pricing formula lives here.
 */
if (!customElements.get('curtain-configurator')) {
  /* ---------------
   * Constants
   * ---------------*/
  const ERROR_DELAY_MS = 600;

  const REQUIRED_TIER_FIELDS = ['min', 'max', 'panels', 'baseCents', 'perDropCents'];

  const MESSAGES = {
    numbersOnly: 'Please use numbers only',
    emptyWidth: 'please enter a width',
    wholeNumber: 'Please enter a whole number of centimetres',
    belowMin: (min) => `Minimum width is ${min}cm`,
    aboveMax: (max) => `Maximum width is ${max}cm`,
    noTier: (width) => `We cant make ${width}cm. Please try another width`,
    enterWidth: 'Enter a width',
    addToCart: (price) => `Add to cart · ${price}`,
    adding: 'Adding…',
    soldOut: 'Sold out',
    unavailable: 'Unavailable',
    summaryEmpty: 'Enter a width to see your curtain',
    summary: (width, drop, fabric) => `Your curtain: ${width} × ${drop}, ${fabric}`,
    cartError: 'Could not add to cart. Please try again.',
    networkError: 'Could not add to cart. Please check your connection and try again.',
  };

  /* -------------------
   * Helpers: data checks
   * ------------------- */

  const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

  const isNumericLabel = (value) => Number.isFinite(parseFloat(value));

  /**
   * Make option values comparable: "121–240 cm" and "121-240cm" become equal.
   */
  const normalize = (value) =>
    String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/[–—]/g, '-') // en dash / em dash -> hyphen
      .replace(/\s+/g, '');

  /**
   * Drop incomplete tiers,  sort by min width and report overlaps or gaps.
   * Warnings are shown in the editor-only debug panel.
   */
  const checkTiers = (rawTiers) => {
    const tiers = [];
    const warnings = [];

    rawTiers.forEach((tier, index) => {
      const missingFields = REQUIRED_TIER_FIELDS.filter((field) => !isNumber(tier[field]));

      if (missingFields.length) {
        warnings.push(`Tier ${index + 1} is missing: ${missingFields.join(', ')}`);
        return;
      }
      if (tier.min > tier.max) {
        warnings.push(`Tier ${index + 1} has min_width greater than max_width`);
        return;
      }
      tiers.push(tier);
    });

    tiers.sort((a, b) => a.min - b.min);

    for (let i = 1; i < tiers.length; i++) {
      const prev = tiers[i - 1];
      const current = tiers[i];

      if (current.min <= prev.max) {
        warnings.push(`Tiers ${prev.min}-${prev.max} and ${current.min}-${current.max} overlap`);
      } else if (current.min > prev.max + 1) {
        warnings.push(`No tier covers ${prev.max + 1}-${current.min - 1}cm`);
      }
    }

    return { tiers, warnings };
  };

  /* ----------------------
   * Helpers: width
   * ---------------------- */

  /** Overall allowed range, e.g. { min: 50, max: 360 }, taken from the tiers. */
  const getWidthLimits = (tiers) => ({
    min: Math.min(...tiers.map((tier) => tier.min)),
    max: Math.max(...tiers.map((tier) => tier.max)),
  });

  /** Tier where min <= width <= max (both inclusive), or null. */
  const findTier = (width, tiers) => tiers.find((tier) => width >= tier.min && width <= tier.max) || null;

  const invalidWidth = (error) => ({ valid: false, value: null, error });

  /**
   * string raw - input.value
   * boolean badInput - input.validity.badInput (letters typed into a number input)
   * returns {{ valid: boolean, value: number|null, error: string }}
   */
  const validateWidth = (raw, badInput, limits, tiers) => {
    const text = String(raw ?? '').trim();

    if (badInput) return invalidWidth(MESSAGES.numbersOnly);
    if (text === '') return invalidWidth(MESSAGES.emptyWidth);
    if (!/^-?\d+(\.\d+)?$/.test(text)) return invalidWidth(MESSAGES.numbersOnly);

    const width = Number(text);

    if (!Number.isInteger(width)) return invalidWidth(MESSAGES.wholeNumber);
    if (width < limits.min) return invalidWidth(MESSAGES.belowMin(limits.min));
    if (width > limits.max) return invalidWidth(MESSAGES.aboveMax(limits.max));
    if (!findTier(width, tiers)) return invalidWidth(MESSAGES.noTier(width));

    return { valid: true, value: width, error: '' };
  };

  /* ------------------
   * Helpers: pricing
   * ------------------ */

  /**
   * Position of the selected drop when drops are sorted shortest to longest,
   * so reordering values in the admin can't silently change prices.
   * Falls back to admin order if a value isn't numeric.
   */
  const getDropStep = (dropValue, dropValues) => {
    const sortedDrops = dropValues.every(isNumericLabel)
      ? [...dropValues].sort((a, b) => parseFloat(a) - parseFloat(b))
      : dropValues;

    return sortedDrops.indexOf(dropValue);
  };

  /** price = base_price + drop_step × price_per_drop_tier (all in cents). */
  const calculatePriceCents = (tier, dropStep) => tier.baseCents + dropStep * tier.perDropCents;

  /**
   * Map a tier to its "Width range" option value, e.g. 121-240 -> "121-240cm".
   * If the admin used a different label, fall back to matching by tier order.
   */
  const widthRangeValueFor = (tier, tierIndex, rangeValues) => {
    const expected = normalize(`${tier.min}-${tier.max}cm`);
    const exactMatch = rangeValues.find((value) => normalize(value) === expected);

    if (exactMatch) return { value: exactMatch, warning: null };

    const byOrder = rangeValues[tierIndex];
    if (byOrder) {
      return {
        value: byOrder,
        warning: `No Width range value matches "${tier.min}-${tier.max}cm"; matched "${byOrder}" by order`,
      };
    }

    return { value: null, warning: `No Width range value for tier ${tier.min}-${tier.max}cm` };
  };

  /* ------------------
   * Helpers: money
   * ------------------*/

  /**
   * Format cents with the shop's money format, e.g. 21000 + "${{amount}}" -> "$210.00".
   * Supports the four standard Shopify placeholders.
   */
  const formatMoney = (cents, format) => {
    const placeholder = /\{\{\s*(\w+)\s*\}\}/;

    const formatAmount = (decimals, thousandsSep, decimalSep) => {
      const [whole, fraction] = (cents / 100).toFixed(decimals).split('.');
      const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, thousandsSep);
      return fraction ? `${grouped}${decimalSep}${fraction}` : grouped;
    };

    const formatters = {
      amount: () => formatAmount(2, ',', '.'),
      amount_no_decimals: () => formatAmount(0, ',', '.'),
      amount_with_comma_separator: () => formatAmount(2, '.', ','),
      amount_no_decimals_with_comma_separator: () => formatAmount(0, '.', ','),
    };

    const key = (format.match(placeholder) || [])[1];
    const formatter = formatters[key] || formatters.amount;

    return format.replace(placeholder, formatter());
  };

  /* -----------------
   * Custom element
   * ---------------- */

  class CurtainConfigurator extends HTMLElement {

    connectedCallback() {
   
      if (this.config) return;

      this.elements = this.getElements();
      this.config = this.parseConfig();

      if (!this.config) {
        this.elements.addLabel.textContent = MESSAGES.unavailable;
        return;
      }

      this.initialPriceText = this.elements.price.textContent.trim();
      this.showWidthError = false;
      this.isLoading = false;
      this.lastWarningsKey = '';
      this.currentAutoMediaId = null;

      this.bindEvents();
      this.update();
    }

    disconnectedCallback() {
      clearTimeout(this.errorTimer);
    }

    /* ----- Setup ----- */

    getElements() {
      return {
        width: this.querySelector('[data-width-input]'),
        widthError: this.querySelector('[data-width-error]'),
        price: this.querySelector('[data-price]'),
        summary: this.querySelector('[data-summary]'),
        addButton: this.querySelector('[data-add-button]'),
        addLabel: this.querySelector('[data-add-label]'),
        cartError: this.querySelector('[data-cart-error]'),
        fabricName: this.querySelector('[data-fabric-name]'),
        slides: this.querySelectorAll('[data-media-id]'),
        thumbs: this.querySelectorAll('[data-thumb]'),
        debug: this.querySelector('[data-debug]'),
      };
    }

    /** Read the JSON rendered by Liquid once and validate it. */
    parseConfig() {
      try {
        const config = JSON.parse(this.querySelector('[data-curtain-config]').textContent);
        const { tiers, warnings } = checkTiers(config.tiers || []);

        if (!tiers.length) throw new Error('No valid pricing tiers');

        if (!config.options.drop.values.every(isNumericLabel)) {
          warnings.push('Drop values are not all numeric; using admin order for drop steps');
        }

        return { ...config, tiers, limits: getWidthLimits(tiers), dataWarnings: warnings };
      } catch (error) {
        console.error('[curtain-configurator] Invalid configuration:', error);
        return null;
      }
    }

    bindEvents() {
      const { width, thumbs, addButton } = this.elements;

      addButton.addEventListener('click', () => this.addToCart());

      width.addEventListener('input', () => this.onWidthInput());
      width.addEventListener('blur', () => this.onWidthBlur());
      width.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        this.addToCart();
      });

      // Scrolling the page over a focused number input would change its value.
      width.addEventListener(
        'wheel',
        () => {
          if (document.activeElement === width) width.blur();
        },
        { passive: true }
      );

      this.addEventListener('change', (event) => {
        if (!event.target.matches('[data-drop-input], [data-fabric-input]')) return;
        this.setCartError('');
        this.update();
      });

      thumbs.forEach((thumb) => {
        thumb.addEventListener('click', () => this.showMedia(thumb.dataset.thumb));
      });
    }

    /* ----- Width events ----- */

    onWidthInput() {
      this.setCartError('');

      // Hide the error while typing, show it again after a short pause.
      this.showWidthError = false;
      clearTimeout(this.errorTimer);
      this.errorTimer = setTimeout(() => {
        this.showWidthError = true;
        this.update();
      }, ERROR_DELAY_MS);

      this.update();
    }

    onWidthBlur() {
      const { width } = this.elements;

      clearTimeout(this.errorTimer);
      // Don't complain about an empty field the customer only tabbed through.
      this.showWidthError = width.value !== '' || width.validity.badInput;
      this.update();
    }

    /* ----- State ----- */

    update() {
      this.state = this.readState();
      this.render(this.state);
      this.reportWarnings(this.state.warnings);
    }

    /**
     * Read the current inputs and work everything out. Never touches the DOM
     * apart from reading, so it is safe to call at any time.
     */
    readState() {
      const { config } = this;
      const { width } = this.elements;
      const checkedDrop = this.querySelector('[data-drop-input]:checked');
      const checkedFabric = this.querySelector('[data-fabric-input]:checked');

      const state = {
        width: validateWidth(width.value, width.validity.badInput, config.limits, config.tiers),
        drop: checkedDrop ? checkedDrop.value : null,
        fabric: checkedFabric ? checkedFabric.value : null,
        fabricLabel: checkedFabric ? checkedFabric.dataset.label : '',
        tier: null,
        dropStep: -1,
        calculatedCents: null,
        variant: null,
        warnings: [...config.dataWarnings],
      };

      if (state.drop) {
        state.dropStep = getDropStep(state.drop, config.options.drop.values);
      }

      if (state.width.valid) {
        state.tier = findTier(state.width.value, config.tiers);

        const widthRange = widthRangeValueFor(
          state.tier,
          config.tiers.indexOf(state.tier),
          config.options.widthRange.values
        );
        if (widthRange.warning) state.warnings.push(widthRange.warning);

        if (state.dropStep >= 0) {
          state.calculatedCents = calculatePriceCents(state.tier, state.dropStep);
        }
        if (widthRange.value) {
          state.variant = this.findVariant(state.drop, state.fabric, widthRange.value);
        }
        if (!state.variant) {
          state.warnings.push('No variant matches this Drop, Fabric and Width range');
        }
      }

      // Price guard: checkout charges the variant price, so that is what we show.
      // Metaobject prices are in the shop currency, so only compare in that currency.
      const pricesOutOfSync =
        config.isBaseCurrency &&
        state.variant &&
        state.calculatedCents !== null &&
        state.variant.priceCents !== state.calculatedCents;

      if (pricesOutOfSync) {
        state.warnings.push('Metaobject and variant prices out of sync');
      }

      return state;
    }

    /* ----- Variants ----- */

    variantHasOption(variant, optionKey, value) {
      const position = this.config.options[optionKey].position;
      return variant.options[position - 1] === value;
    }

    findVariant(drop, fabric, widthRange) {
      const match = this.config.variants.find(
        (variant) =>
          this.variantHasOption(variant, 'drop', drop) &&
          this.variantHasOption(variant, 'fabric', fabric) &&
          this.variantHasOption(variant, 'widthRange', widthRange)
      );

      return match || null;
    }

    /* ----- Rendering ----- */

    /**
     * The only place that writes to the page. It only changes text and
     * attributes in pre-sized slots, which keeps layout shift at zero.
     */
    render(state) {
      const formatPrice = (cents) => formatMoney(cents, this.config.moneyFormat);

      this.renderWidthError(state);
      this.renderPrice(state, formatPrice);
      this.renderButton(state, formatPrice);
      this.renderSummary(state);
      this.renderMedia(state);
      this.renderDebug(state, formatPrice);
    }

    renderWidthError(state) {
      const { width, widthError } = this.elements;
      const isVisible = this.showWidthError && !state.width.valid;

      width.setAttribute('aria-invalid', String(isVisible));
      // Keep the last message while hidden; the slot keeps its height either way.
      if (isVisible) widthError.textContent = state.width.error;
      widthError.classList.toggle('is-visible', isVisible);
    }

    renderPrice(state, formatPrice) {
      this.elements.price.textContent = state.variant
        ? formatPrice(state.variant.priceCents)
        : this.initialPriceText;
    }

    renderButton(state, formatPrice) {
      // While a request is running, setLoading() owns the button.
      if (this.isLoading) return;

      const { addButton, addLabel } = this.elements;
      let label = MESSAGES.enterWidth;
      let disabled = true;

      if (state.width.valid) {
        if (!state.variant) {
          label = MESSAGES.unavailable;
        } else if (!state.variant.available) {
          label = MESSAGES.soldOut;
        } else {
          label = MESSAGES.addToCart(formatPrice(state.variant.priceCents));
          disabled = false;
        }
      }

      addLabel.textContent = label;
      addButton.disabled = disabled;
    }

    renderSummary(state) {
      const { summary, fabricName } = this.elements;
      const isComplete = state.width.valid && state.drop && state.fabric;

      summary.textContent = isComplete
        ? MESSAGES.summary(state.width.value, state.drop, state.fabricLabel)
        : MESSAGES.summaryEmpty;

      if (fabricName) fabricName.textContent = state.fabricLabel;
    }

    renderMedia(state) {
      // Before a width is entered there is no exact variant yet, so use any
      // variant with the selected drop + fabric that has an image.
      const mediaVariant =
        state.variant ||
        this.config.variants.find(
          (variant) =>
            variant.featuredMediaId &&
            this.variantHasOption(variant, 'drop', state.drop) &&
            this.variantHasOption(variant, 'fabric', state.fabric)
        );

      const mediaId = mediaVariant && mediaVariant.featuredMediaId;

      // Only switch when the variant image changes, so a thumbnail the
      // customer clicked isn't overridden on every keystroke.
      if (mediaId && mediaId !== this.currentAutoMediaId) {
        this.currentAutoMediaId = mediaId;
        this.showMedia(mediaId);
      }
    }

    /** Editor-only panel (rendered by Liquid only when request.design_mode is true). */
    renderDebug(state, formatPrice) {
      const { debug } = this.elements;
      if (!debug) return;

      const setField = (field, value) => {
        const element = debug.querySelector(`[data-debug-field="${field}"]`);
        if (element) element.textContent = value;
      };

      const { tier, variant } = state;
      const guardNote = this.config.isBaseCurrency ? '' : ' (price guard off: non-base currency)';

      setField('tier', tier ? `${tier.min}-${tier.max}cm` : '–');
      setField('panels', tier ? String(tier.panels) : '–');
      setField('dropStep', state.dropStep >= 0 ? String(state.dropStep) : '–');
      setField('calculated', state.calculatedCents !== null ? formatPrice(state.calculatedCents) + guardNote : '–');
      setField('variantId', variant ? String(variant.id) : '–');
      setField('variantPrice', variant ? formatPrice(variant.priceCents) : '–');
      setField('warnings', state.warnings.length ? state.warnings.join(' · ') : 'None');
    }

    /** Log warnings to the console only when they change, not on every keystroke. */
    reportWarnings(warnings) {
      const key = warnings.join('|');
      if (key && key !== this.lastWarningsKey) console.warn('[curtain-configurator]', ...warnings);
      this.lastWarningsKey = key;
    }

    /* ----- Media gallery ----- */

    showMedia(mediaId) {
      const id = String(mediaId);
      const targetSlide = [...this.elements.slides].find((slide) => slide.dataset.mediaId === id);
      if (!targetSlide) return;

      this.elements.slides.forEach((slide) => {
        slide.hidden = slide !== targetSlide;
      });

      this.elements.thumbs.forEach((thumb) => {
        if (thumb.dataset.thumb === id) {
          thumb.setAttribute('aria-current', 'true');
        } else {
          thumb.removeAttribute('aria-current');
        }
      });
    }

    /* ----- Cart ----- */

    async addToCart() {
      if (this.isLoading) return; // blocks double clicks

      // Re-read the inputs now instead of trusting earlier state.
      this.update();
      const { state } = this;

      if (!state.width.valid) {
        this.showWidthError = true;
        this.update();
        this.elements.width.focus();
        return;
      }
      if (!state.variant || !state.variant.available) return;

      const cart = document.querySelector('cart-drawer') || document.querySelector('cart-notification');
      const body = this.buildCartPayload(state, cart);

      if (cart) cart.setActiveElement(document.activeElement);

      this.setCartError('');
      this.setLoading(true);

      try {
        const response = await fetch(`${window.routes.cart_add_url}.js`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await response.json();

        if (!response.ok || data.status) {
          this.setCartError(data.description || data.message || MESSAGES.cartError);
          return;
        }

        // Cart type "Page": no drawer or notification to refresh.
        if (!cart) {
          window.location = window.routes.cart_url;
          return;
        }

        cart.classList.remove('is-empty');
        cart.renderContents(data);
        this.publishCartUpdate(state.variant.id, data);
      } catch (error) {
        console.error('[curtain-configurator] Add to cart failed:', error);
        this.setCartError(MESSAGES.networkError);
      } finally {
        this.setLoading(false);
      }
    }

    /**
     * Single-item body (not `items: [...]`): the response is then the line
     * item itself, with the `key` and `id` Dawn's cart renderContents() needs.
     * Properties starting with "_" are hidden from the customer by Shopify.
     */
    buildCartPayload(state, cart) {
      const body = {
        id: state.variant.id,
        quantity: 1,
        properties: {
          Width: `${state.width.value}cm`,
          Drop: state.drop,
          _fabric_panels: String(state.tier.panels),
        },
      };

      // Section Rendering API: get the updated cart HTML in the same response.
      if (cart) {
        body.sections = cart.getSectionsToRender().map((section) => section.id);
        body.sections_url = window.location.pathname;
      }

      return body;
    }

    /** Let other Dawn components (e.g. cart counters) know the cart changed. */
    publishCartUpdate(variantId, cartData) {
      if (typeof publish !== 'function' || typeof PUB_SUB_EVENTS === 'undefined') return;

      publish(PUB_SUB_EVENTS.cartUpdate, {
        source: 'curtain-configurator',
        productVariantId: variantId,
        cartData,
      });
    }

    /* ----- UI helpers ----- */

    setLoading(isLoading) {
      const { addButton, addLabel } = this.elements;

      this.isLoading = isLoading;
      addButton.setAttribute('aria-busy', String(isLoading));

      if (isLoading) {
        addButton.disabled = true;
        addLabel.textContent = MESSAGES.adding;
      } else {
        this.update(); // restores the correct label and disabled state
      }
    }

    setCartError(message) {
      const { cartError } = this.elements;
      if (message) cartError.textContent = message;
      cartError.classList.toggle('is-visible', Boolean(message));
    }
  }

  customElements.define('curtain-configurator', CurtainConfigurator);
}
