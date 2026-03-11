# Restaurant Cost Control App

A self-hosted, browser-based food cost management system built for restaurants. No backend database required — all data lives in the browser's `localStorage`.

---

## Quick Start

```bash
node server.js
# Open http://localhost:3000
```

The Node server only serves static files. All business logic runs in the browser.

**First-time setup:**
1. Open Settings (⚙ gear icon in the header)
2. Enter your Anthropic API key (required for AI features)
3. Enter your Square Access Token and Location ID (required for Square sales import)
4. Add your suppliers, ingredients, and recipes

---

## Modules

| Module | Description |
|---|---|
| **Ingredients** | WAC-based ingredient library with purchase history and yield adjustment |
| **Recipes** | Multi-level recipe costing with sub-recipes and sundry % |
| **Menu** | Menu items with live food cost %, gross profit, avg sell price from sales data |
| **Sales** | Record sales manually or import from Square API / CSV |
| **Production** | Batch production tracking for bulk-made items (sauces, doughs, desserts) |
| **Inventory** | Stock count variance — actual vs theoretical usage |
| **Reports** | Period P&L and sundry variance report |
| **Prep** | Daily kitchen prep checklist grouped by ingredient type |
| **Import** | AI-powered invoice import via PDF upload or Gmail email pipeline |

---

## Core Concepts

### Weighted Average Cost (WAC)

WAC is the central cost metric. Every time a purchase is recorded, the cost per recipe unit is recalculated across **all active purchases** — not just the latest one. This smooths out price volatility over time.

```
WAC = Total spend across all active purchases
      ─────────────────────────────────────────
      Total base units across all active purchases
```

**Example:** 10 kg flour at $1.00/kg last month + 10 kg at $1.20/kg this week:
```
WAC = ($10 + $12) / (10,000g + 10,000g) = $0.0011/g
```

WAC is recalculated from scratch on every purchase add, edit, or delete.

---

### Yield Adjustment

Ingredients lose weight during prep (peeling, trimming, cooking). The **Yield %** field accounts for this.

```
Effective cost per recipe unit = WAC / (Yield% / 100)
```

**Example:** Chicken breast WAC $0.012/g, yield 80%:
```
Effective cost = $0.012 / 0.80 = $0.015/g
```

Recipes always use the yield-adjusted effective cost. Raw WAC is shown separately for reference.

---

### Unit Conversion (Buy → Recipe)

Ingredients are purchased in one unit and used in recipes in another.

**Weight/volume buy units** (kg, g, L, ml):
```
baseUnits = buyQty × 1000  (if kg or L)
```

**Pack-based buy units** (carton, case, bag, box, each, dozen):
```
baseUnits = buyQty × packCount × packSize
```

**Example:** 1 carton of 6 × 800 g tomato paste tins:
```
buyUnit = carton, packCount = 6, packSize = 800g
baseUnits = 1 × 6 × 800 = 4,800g
```

---

### Recipe Costing

```
Ingredient cost   = effectiveCost(ingredient) × qty
Sub-recipe cost   = calcRecipeCost(lines) × qty  [recursive]
Sundry cost       = ingredient cost total × (sundryPct / 100)
Total recipe cost = ingredient cost + sub-recipe cost + sundry cost
```

**Sundry %** covers unmeasurable ingredients like salt, oil, and herbs — a blanket percentage added on top of the measured ingredient cost.

---

### Batch Production

Recipes flagged as **Batch Produced** (e.g. sauces, doughs, desserts) are tracked via the Production module rather than sold directly.

1. Record a production batch: recipe + portions produced
2. The app calculates the total cost and adds a "purchase" to a `<Name> [batch]` finished-goods ingredient
3. The finished-goods ingredient gets a new WAC: `total cost / portions produced`
4. The finished-goods ingredient flows through to stock count variance like any other ingredient

For stock count variance:
- Raw ingredient usage is driven by **production batches**
- Finished-goods `[batch]` usage is driven by **sales**

---

### Stock Count Variance

```
Actual usage     = opening stock + purchases in period − closing stock
Theoretical use  = sum of (recipe qty × portions sold) for all sales in period
Variance         = actual − theoretical
```

Opening stock is automatically pulled from the closing stock of the most recent prior count.

---

### Sundry Variance Report

Compares your **estimated** sundry spend (Sundry % × recipe cost × portions sold) against your **actual** sundry spend (purchases of ingredients categorised as `Sundry`). The variance tells you whether your Sundry % needs adjusting up or down.

**Setup:**
- Set Sundry % on recipes that use unmeasurables
- Categorise ingredients like "Salt", "Olive Oil", "Mixed Herbs" as `Sundry`
- Log purchases of those ingredients

---

## Square Sales Import

### API Fetch (recommended)

1. Enter your Square Access Token and Location ID in Settings
2. Go to Import → Sales, select a date range, click **Fetch from Square**
3. The app pulls orders from the Square Orders API, grouped by item and day
4. Revenue is taken from `net_sales_money` (ex-GST, ex-discounts — matches Square's "Net Sales")
5. Delivery orders (Doshii/Uber Eats) are detected by source name and have the commission % deducted from revenue
6. Review the matched items and approve to save

**Duplicate guard:** importing the same date range twice will prompt for confirmation before creating duplicates.

### CSV Upload

Export the **Items** report from Square Dashboard → Reports → Sales, then upload it on the Import page.

---

## Modifier Library

Modifier rules are managed on the **Menu** page. They are auto-populated from Square imports and can also be added manually.

Each modifier can be linked to an ingredient + qty — in which case its cost is calculated live from WAC. Unlinked modifiers use a manual fixed cost. Modifier costs are applied as an extra per-unit cost when recording sales.

---

## AI Invoice Import

### Manual PDF Upload

1. Upload a supplier invoice (PDF) on the Import page
2. Claude AI extracts line items (name, qty, unit, price, pack details)
3. Claude AI matches extracted items to your ingredient library
4. Review and approve — confirmed matches update each ingredient's WAC

### Email Pipeline (Gmail → Google Sheet → App)

For hands-free processing of invoices delivered by email:

```
Supplier sends PDF invoice to your Gmail
        ↓
Google Apps Script (runs every 10 minutes)
  - Filters by supplier whitelist
  - Sends PDF to Claude API
  - Stores extracted JSON in Google Sheet
        ↓
App polls the Google Sheet Web App URL
  - Pending invoices appear on the Import page
  - Click "Review" to open the wizard at the matching step
  - Approve to mark the invoice as imported in the sheet
```

Setup: see `gmail-invoice-script/Code.gs` for installation instructions.

---

## Settings

Access via the ⚙ gear icon in the header.

| Setting | Purpose |
|---|---|
| Anthropic API Key | Required for AI invoice import and Square CSV matching |
| Square Access Token | Required for Square Orders API fetch |
| Square Location ID | One or more location IDs (comma-separated) |
| Gmail Invoice Queue URL | Google Apps Script Web App URL for the email pipeline |
| Supplier Whitelist | Newline-separated supplier emails for the Apps Script filter |
| Delivery Commission % | Deducted from delivery channel revenue (Doshii/Uber Eats) |
| Delivery Channel Name | Must match the source name in Square (e.g. `Doshii`) |

**Data backup/restore** — export and import the full database as JSON from the Settings modal.

---

## Data Storage

All data is stored as JSON in `localStorage` under the key `rcc-v4`. There is no server-side database.

| Collection | Contents |
|---|---|
| `db.suppliers` | Supplier reference list |
| `db.ingredients` | Ingredient library with purchase history and WAC |
| `db.recipes` | Recipe lines, sundry %, batch flag |
| `db.menuItems` | Menu items linking a recipe to a selling price |
| `db.sales` | Sales records with cost snapshot at time of sale |
| `db.productionBatches` | Batch production records |
| `db.stockCounts` | Stock count periods with opening/closing quantities |
| `db.prepTasks` | Kitchen prep checklist tasks |
| `db.modifierLinks` | Square modifier cost rules |
| `db.importLog` | Audit trail of all invoice and sales imports |

**`snapshotCost`** — when a sale is recorded, the yield-adjusted ingredient cost is captured as a point-in-time snapshot. Historical profitability is not affected by future WAC changes.

---

## Script Load Order

```
data/db.js          — db object, localStorage, WAC utilities
js/ingredients.js   — WAC core, ingredient CRUD, purchase history
js/recipes.js       — Recipe costing, menu items
js/sales.js         — Sales recording and export
js/reports.js       — P&L and sundry variance reports
js/inventory.js     — Stock counts, variance, theoretical usage
js/import.js        — AI invoice wizard, email queue, Square import, modifier library
js/production.js    — Production batch CRUD, finished-goods WAC update
js/prep.js          — Kitchen prep checklist
js/app.js           — Navigation, suppliers, dashboard, settings, init
```
