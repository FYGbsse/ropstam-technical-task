# Made-to-Measure Curtain Configurator

A custom made-to-measure curtain configurator built on **Shopify Dawn**.

Customers enter their required width, select a drop and fabric, and receive a live price based on the configured pricing tiers. The selected variant is added to the cart so the price shown to the customer is the same price Shopify uses at checkout.

## Domain Model

Made-to-measure curtains require two measurements:

* **Width** — the width of the curtain along the pole.
* **Drop** — the finished length of the curtain.

Fabric rolls have a fixed width, so wider curtains require multiple panels sewn together. The number of panels determines the amount of fabric and therefore the base price.

The customer only needs to enter their window width. The configurator determines the required panel count in the background and stores it with the order for production.

## Technical Approach

### Variant-Based Pricing

Shopify uses the selected variant price when the product is added to the cart. Because the curtain price is determined by **width tier + drop**, each price combination is represented by a real Shopify variant.

The product uses three options:

* **Drop** — displayed as buttons.
* **Fabric** — displayed as swatches.
* **Width range** — selected automatically from the customer's entered width and not exposed as a customer-facing control.

When the customer enters a width, the configurator:

1. Finds the matching pricing tier from the Metaobject.
2. Calculates the price for the selected drop.
3. Selects the matching Shopify variant.
4. Adds that variant to the cart with the customer's width and drop as line-item properties.

This means the variant itself carries the final Shopify price rather than relying on a JavaScript-only price calculation.

### Pricing Data

Pricing is stored in a **Curtain Pricing Tier** Metaobject and linked to the product through `custom.pricing_tiers`.

No pricing ranges, limits or panel counts are hardcoded in the JavaScript.

The sample configuration contains:

| Width     | Panels | Base | Drop Tier |
| 50–120cm  |      1 | $100 |       $20 |
| 121–240cm |      2 | $180 |       $30 |
| 241–360cm |      3 | $260 |       $40 |

The price is calculated as:

`base_price + (drop_step × price_per_drop_tier)`

For example, a **180cm × 200cm** curtain falls into the 121–240cm tier:

`$180 + ($30 × 1) = $210`

Drop steps are determined by sorting the available drops by their numeric value, so their order in the Shopify admin does not affect pricing.

## Cart Handling

The configurator uses Shopify's `/cart/add.js` endpoint.

Customer-visible properties:

* Width
* Drop

Production-only property:

* `_fabric_panels`

The underscore prefix keeps the panel count hidden from customers while preserving it on the order for the workroom.

The cart request also uses Shopify's **Section Rendering API** to refresh the Dawn cart drawer without a full page reload.

The add-to-cart button is disabled while the request is processing to prevent duplicate submissions, and Shopify API errors are displayed to the customer.

## Alternative Considered: Cart Transform

A Shopify Function using Cart Transform could move parts of the pricing logic to Shopify's server side.

For this implementation, variant-based pricing was preferred because the pricing model is small and deterministic. It avoids introducing a custom app and keeps the final checkout price represented directly by the product variant.


## Requirements From the Brief

The implementation follows the requested data model:

* Metaobject: `Curtain Pricing Tier`
* Fields: `min_width`, `max_width`, `panels_required`, `base_price`, `price_per_drop_tier`
* Product metafield: `custom.pricing_tiers`
* Section: `sections/curtain-configurator.liquid`
* Custom element or js component: `<curtain-configurator>`
* JavaScript: vanilla JS, no libraries
* Width range: determined from Metaobject data
* Drop: product option
* Fabric: product option with configurable swatches
* Cart: Shopify Ajax Cart API
* Cart refresh: Section Rendering API

## Customer Experience

The customer:

1. Enters the curtain width.
2. Selects a drop.
3. Selects a fabric.
4. Sees the price update immediately.
5. Adds the curtain to the cart.

Invalid, decimal, non-numeric or out-of-range widths receive a clear validation message.

The configurator does not expose panel counts to the customer.

## Admin Experience

Pricing can be managed through Shopify's Metaobjects rather than editing code.

To add a new width tier:

1. Create a new Metaobject entry.
2. Add it to the product's `custom.pricing_tiers` metafield.
3. Add the corresponding Width range value and variants.
4. Set the variant prices.

To add a new drop or fabric, add the corresponding product option values and variants. Fabric swatches can be configured through the section blocks.

The theme editor also includes a development-only debug panel showing the resolved tier, panel count, price and variant for a given width.

## Files

sections/ curtain-configurator.liquid
assets/curtain-configurator.js
assets/curtain-configurator.js
templates/product.curtain.json


`curtain-configurator.liquid` renders the configurator and passes the Shopify data to JavaScript.

`curtain-configurator.js` handles validation, tier matching, price calculation, variant selection and cart requests.

`curtain-configurator.css` contains the configurator-specific styles

`product.curtain.json` provides a dedicated product template.

**No Dawn core files were modified.**

## Accessibility & Performance

* Native radio inputs for drops and fabrics
* Keyboard-accessible controls
* Visible focus states
* Accessible price and validation announcements
* No JavaScript libraries
* Deferred custom script
* Lazy-loaded images
* Reserved space for dynamic content to prevent layout shift

## Order Data Integrity

The panel count is recalculated when the customer adds the product to the cart rather than relying on a previously calculated value.

## Development

Development followed a simple workflow:

* Created repo in github with nane ropstam-technical-task.
* Clone repo in locally.
* Add Dawn theme files in locally repo or directory.
* Push initial Dawn theme to github
* Sync Github with Shopify store and connect theme through it.
* Using **Shopify CLI**, login , preview and develop locally
* Once code is tested locally, push to theme using git.





## Links

**Live Store:** `https://YOUR-STORE.myshopify.com/products/...`

**Store Password:** `ropstam`

**Repository:** `https://github.com/FYGbsse/ropstam-technical-task`


## Screenshot

assets/cc-desktop.png
assets/cc-mobile-view.png
assets/cc-desktop-cart.png
assets/cc-checkout.png
assets/cc-admin-order.png
assets/cc-editor.png
assets/cc-metaobject-definition.png
assets/cc-metaobject-entries.png
assets/cc-metaobject-values.png
