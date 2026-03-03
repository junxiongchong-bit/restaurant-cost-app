# Restaurant Cost Control App

A self-hosted, browser-based food cost management system for restaurants. No backend database required — all data is stored in the browser's `localStorage` under the key `rcc-v4`.

---

## Running the App

```bash
node server.js
# Open http://localhost:3000
```

The Node server only serves static files. All logic runs in the browser.

---

## Core Concepts

### Weighted Average Cost (WAC)

WAC is the central cost metric. Every time you receive a new purchase of an ingredient, the cost per recipe unit is recalculated across **all active purchases** — not just the latest one. This smooths out price volatility so that a one-off expensive delivery does not spike your recipe costs overnight.

```
WAC (per recipe unit) = Total spend across all active purchases
                        ─────────────────────────────────────────
                        Total base units across all active purchases
```

**Example:** If you bought 10kg flour at $1.00/kg last month and 10kg at $1.20/kg this week:

```
WAC = ($10 + $12) / (10,000g + 10,000g) = $0.0011/g
```

WAC is recalculated from scratch every time a purchase is added, edited, or deleted — there is no running balance that can drift.

---

### Yield Adjustment

Ingredients lose weight during prep (peeling, trimming, cooking). The **Yield %** field accounts for this. An ingredient with 80% yield means only 80% of what you buy is actually usable in a recipe.

```
Effective cost per recipe unit = WAC ÷ (Yield% ÷ 100)
```

**Example:** Chicken breast at WAC $0.012/g, yield 80%:

```
Effective cost = $0.012 ÷ 0.80 = $0.015/g
```

Recipes use the **yield-adjusted effective cost** for all food cost calculations. Raw WAC is shown separately for reference.

---

### Unit Conversion (Buy → Recipe)

Ingredients are purchased in one unit and used in recipes in another. The app handles this through two pathways:

**Pathway 1 — Weight/volume buy units** (kg, g, L, ml):
```
baseUnits = buyQty × (1000 if kg or L)
```

**Pathway 2 — Pack-based buy units** (carton, case, bag, box, each, dozen):
```
baseUnits = buyQty × packCount × packSize
```

`packSize` is converted to base units (g or ml) automatically — e.g. `packUnit = kg` multiplies by 1000.

**Example:** 1 carton of 6 × 800g tomato paste tins:
```
buyUnit = carton, buyQty = 1, packCount = 6, packSize = 800, packUnit = g
baseUnits = 1 × 6 × 800 = 4,800g
```

This allows produce like zucchini (bought by the `each`) to be used in recipes in grams, as long as you enter the average weight per unit as `packSize`.

---

## Data Schema

All data lives in the `db` object, persisted as JSON in localStorage.

### `db.suppliers`
```json
[{ "id": "...", "name": "Bidvest Foods", "contact": "..." }]
```
Reference table. Linked to ingredients and purchase records.

---

### `db.ingredients`
The core of the cost engine. Each ingredient has a purchase history and a live WAC.

```json
{
  "id": "abc123",
  "name": "Chicken Breast",
  "category": "Protein",
  "supplierId": "sup_id",
  "recipeUnit": "g",          // unit used in recipe lines: g | ml | each
  "yield": 80,                // usable percentage after prep
  "wac": 0.01200,             // cost per recipeUnit, recalculated from purchases
  "totalBaseUnits": 20000,    // total g/ml/each across all active purchases
  "purchases": [
    {
      "id": "pur_id",
      "date": "2026-02-01",
      "supplierId": "sup_id",
      "buyUnit": "kg",
      "buyQty": 10,
      "packCount": null,
      "packSize": null,
      "packUnit": "g",
      "totalPrice": 120.00,
      "cpru": 0.01200,        // cost per recipe unit for this purchase
      "baseUnits": 10000,     // grams in this purchase
      "obsolete": false       // true = excluded from WAC (manual override)
    }
  ],
  "batchLinkedRecipeId": null // set only for auto-created batch finished-goods ingredients
}
```

**Special category — `Sundry`:** Ingredients categorised as `Sundry` (salt, oil, herbs) are excluded from stock count dropdowns and tracked separately in the Sundry Variance Report.

**Special category — `Batch`:** Auto-created `[batch]` ingredients (e.g. `Tiramisu [batch]`) are finished-goods placeholders created by the Production system. Do not edit these manually.

---

### `db.recipes`
Recipes are cost templates. They contain **lines** that reference ingredients or other recipes (sub-recipes).

```json
{
  "id": "rec_id",
  "name": "Beef Bolognese",
  "category": "Pasta",
  "type": "menu",             // "menu" | "base" (sub-recipe)
  "yield": "Serves 1",       // descriptive note only, not used in calculations
  "batchProduced": false,     // true = tracked via Production module
  "sundryPct": 3,             // % of ingredient cost added for unmeasurables (salt, oil, etc.)
  "lines": [
    { "ref": "ing:abc123", "qty": 180 },   // 180g Chicken Breast
    { "ref": "rec:sub_id", "qty": 1 }      // 1 portion of a sub-recipe
  ]
}
```

**Recipe cost formula:**
```
Ingredient cost  = effectiveCost(ingredient) × qty
Sub-recipe cost  = calcRecipeCost(sub-recipe.lines) × qty  [recursive]
Sundry cost      = ingredient cost total × (sundryPct ÷ 100)
Total recipe cost = ingredient cost + sub-recipe cost + sundry cost
```

**`snapshotCost`** — when a sale is recorded, the recipe's yield-adjusted cost (excluding sundry) is captured as a point-in-time snapshot. This means historical profitability reports are not affected by future ingredient price changes.

---

### `db.menuItems`
Menu items link a recipe to a selling price.

```json
{
  "id": "menu_id",
  "name": "Spaghetti Bolognese",
  "category": "Mains",
  "price": 28.00,
  "recipeId": "rec_id"
}
```

Cost %, gross profit, and food cost displayed on the Menu page are always live (recalculated from current WAC). The displayed cost includes the recipe's sundry %.

---

### `db.sales`
```json
{
  "id": "sale_id",
  "date": "2026-03-01",
  "itemId": "menu_id",
  "qty": 3,
  "revenue": 84.00,
  "snapshotCost": 9.42        // yield-adj cost per unit AT TIME OF SALE (no sundry)
}
```

Sales are used for:
- P&L reports (revenue vs food cost vs profit)
- Theoretical ingredient usage in stock count variance
- Theoretical sundry cost in the Sundry Variance Report

---

### `db.productionBatches`
Used only for recipes flagged `batchProduced: true` (e.g. sauces, desserts made in bulk).

```json
{
  "id": "batch_id",
  "date": "2026-03-01",
  "recipeId": "rec_id",
  "portionsProduced": 40,
  "note": "Morning prep"
}
```

When a batch is saved, the app:
1. Calculates total cost: `calcRecipeCost(recipe.lines) × portionsProduced`
2. Adds a "purchase" record to the `<Name> [batch]` finished-goods ingredient
3. Recalculates WAC on that ingredient: `total cost ÷ portions produced`

The finished-goods ingredient is then used in stock count variance like any other ingredient.

---

### `db.stockCounts`
Stock counts measure actual ingredient usage and compare it to theoretical usage.

```json
{
  "id": "sc_id",
  "dateFrom": "2026-03-01",
  "dateTo": "2026-03-07",
  "note": "Week 9",
  "lines": [
    {
      "ingredientId": "abc123",
      "openQty": 5,
      "openUnit": "kg",
      "closeQty": 2.5,
      "closeUnit": "kg"
    }
  ]
}
```

**Variance calculation per ingredient:**
```
Actual usage    = opening stock + purchases in period − closing stock
Theoretical use = sum of (recipe qty × portions sold) for all sales in period
Variance        = actual − theoretical
```

Opening stock is automatically derived from the closing stock of the most recent prior count (linked by date).

For **batch-produced recipes**, theoretical usage is split:
- Raw ingredients → driven by **production batches** (not sales)
- Finished-goods `[batch]` ingredient → driven by **sales**

---

### `db.modifierLinks`
Modifier cost rules for Square-imported sales with customisations (e.g. `+Avocado`, `No Onion`).

```json
{
  "pattern": "+Avocado",
  "type": "add",              // "add" | "remove" | "neutral"
  "ingredientId": "ing_id",  // linked ingredient for WAC-based auto-cost
  "qty": 50,                  // grams per modifier
  "unit": "g",
  "extraCost": 0              // manual fallback if no ingredient linked
}
```

When `ingredientId` + `qty` are set, the cost is calculated live from WAC: `effectiveCost(ingredient) × qty`. This means modifier costs stay accurate as ingredient prices change.

---

### `db.importLog`
Audit trail of all invoice and Square sales imports.

```json
{
  "id": "log_id",
  "type": "invoice",          // "invoice" | "square"
  "date": "2026-03-01",
  "filename": "bidvest_mar.pdf",
  "supplierName": "Bidvest",
  "itemCount": 12,
  "matchedCount": 10,
  "totalValue": 843.50
}
```

---

## Entity Relationships

```
Supplier ──────────────────┐
                           │ supplierId
                    Ingredient ──────────────────────────────────┐
                    │  purchases[]                               │ ref: ing:id
                    │  wac (recalculated on every purchase)      │
                    │  effectiveCost = wac ÷ yield               │
                    │                                            │
                    │ batchLinkedRecipeId                        │
                    └──── [batch] ingredient ◄──────────────────┤
                                  ▲                             │
                                  │ WAC updated on save         │
                           ProductionBatch ◄────── Recipe ──────┘
                                                   │ lines[]
                                                   │ sundryPct
                                                   │ batchProduced
                                                   │
                                               MenuItem ─── price
                                                   │
                                               Sale ──────────────── Reports
                                               │ snapshotCost       P&L
                                               │                    Sundry Variance
                                               │
                                         StockCount
                                         │ lines[]
                                         │ dateFrom / dateTo
                                         │
                                    Variance Report
                                    actual vs theoretical usage
```

---

## Sundry % and Variance Report

**The problem:** Some ingredients (salt, sugar, cooking oil, herbs) are impossible to measure per dish accurately.

**The solution — two-tier approach:**

1. **Sundry %** on each recipe: a blanket percentage (e.g. 3%) applied to the measured ingredient cost to estimate unmeasurable spend. This flows through to menu item cost display and is shown separately from the measured food cost.

2. **Sundry Variance Report** (Reports page): compares theoretical sundry spend (Sundry % × recipe cost × portions sold) against actual sundry spend (purchases of ingredients categorised as `Sundry`). The variance tells you whether to raise or lower your %.

To use it:
- Set Sundry % on recipes that use unmeasurables
- Add ingredients like "Salt", "Olive Oil", "Mixed Herbs" with category = `Sundry`
- Log purchases of those ingredients
- The variance report reconciles the estimate against real spend

---

## AI Invoice Import

Two import modes share the same review wizard:

### Manual Upload
1. Upload a PDF invoice
2. Claude AI extracts line items (name, qty, unit, price, pack details)
3. Claude AI matches extracted items to your ingredient library
4. Review and approve — each match updates the ingredient's WAC

### Email Pipeline (Gmail → Google Sheet → App)
For hands-free processing of supplier invoices delivered by email:

```
Supplier sends PDF to your Gmail
        ↓
Google Apps Script (every 10 min)
  • Filters by SUPPLIER_WHITELIST
  • Sends PDF to Claude API
  • Stores extracted JSON in Google Sheet
        ↓
App polls Google Sheet Web App URL
  • Shows pending invoices on Import page
  • Click "Review →" → opens wizard at matching step (no re-extraction)
  • Approve → marks invoice as "imported" in the sheet
```

Setup: see `gmail-invoice-script/Code.gs` for Google Apps Script installation instructions.

---

## AI Cost Snapshot Design Decision

`snapshotCost` on sales records the **yield-adjusted ingredient cost only** (no sundry). Sundry is always calculated separately from the snapshot using `recipe.sundryPct`. This separation means:

- Food cost reports show pure ingredient cost, clearly
- Sundry cost is shown as a distinct line
- Changing the sundry % does not retroactively alter historical food cost figures
- WAC changes after the sale date do not affect historical profitability

---

## Settings

Accessed via the ⚙ icon in the header:

| Setting | localStorage key | Purpose |
|---|---|---|
| Anthropic API Key | `rcc-api-key` | Required for invoice AI extraction and Square import AI matching |
| Gmail Invoice Queue URL | `rcc-gmail-webapp-url` | Google Apps Script Web App URL for email pipeline |
| Supplier Whitelist | `rcc-gmail-whitelist` | Newline-separated emails for Apps Script (reference copy) |
| Delivery Commission % | `rcc-delivery-commission` | Applied to delivery platform sales cost% calculations |

**Data backup/restore** is also available in Settings — exports and imports the full `db` object as JSON.

---

## Script Load Order

```
data/db.js          — db object, storage, WAC utilities, sort helpers
js/ingredients.js   — WAC core, ingredient CRUD, purchase history
js/recipes.js       — Recipe costing, menu items
js/sales.js         — Sales recording
js/reports.js       — P&L and sundry variance reports
js/inventory.js     — Stock counts, variance, theoretical usage
js/import.js        — AI invoice wizard, email queue, Square import, modifier library
js/production.js    — Production batch CRUD, finished-goods WAC update
js/app.js           — Navigation, suppliers, dashboard, settings, init
```

`app.js` bootstraps the app:
```javascript
(async () => { await loadDB(); renderDashboard(); })();
```
