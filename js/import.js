// ── DEV MODE ────────────────────────────────────────────────────────────────
let DEV_MODE = true;

const DEV_INVOICE_DATA = [
  { name: "Chicken Breast", buy_unit: "kg", buy_qty: 5, total_price: 32.50, pack_count: null, pack_size: null, pack_unit: "g", recipe_unit: "g", notes: "" },
  { name: "Beef Mince",     buy_unit: "kg", buy_qty: 3, total_price: 24.00, pack_count: null, pack_size: null, pack_unit: "g", recipe_unit: "g", notes: "" },
  { name: "Tomato Paste",   buy_unit: "carton", buy_qty: 1, total_price: 18.00, pack_count: 6, pack_size: 800, pack_unit: "g", recipe_unit: "g", notes: "6x800g cans" },
  { name: "Olive Oil",      buy_unit: "each", buy_qty: 2, total_price: 22.00, pack_count: null, pack_size: null, pack_unit: "ml", recipe_unit: "ml", notes: "2L bottle" },
  { name: "Plain Flour",    buy_unit: "kg", buy_qty: 10, total_price: 14.00, pack_count: null, pack_size: null, pack_unit: "g", recipe_unit: "g", notes: "" }
];

// ── EMAIL INVOICE QUEUE ───────────────────────────────────────────────────────
// Polls the Google Apps Script Web App for invoices auto-extracted from Gmail.
// Supplier emails → Apps Script → Claude API → Google Sheet → here.

let emailQueueItems = []; // holds fetched items so onclick handlers can reference by index

async function pollEmailQueue() {
  const url = localStorage.getItem('rcc-gmail-webapp-url');
  const el  = document.getElementById('email-queue-list');
  if (!el) return;
  if (!url) {
    el.innerHTML = '<div class="muted" style="font-size:.82rem">Configure Gmail Invoice Queue URL in Settings (⚙) to enable.</div>';
    return;
  }
  el.innerHTML = '<div class="muted" style="font-size:.82rem">Checking for new invoices…</div>';
  try {
    const res  = await fetch(url);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Unknown error');
    renderEmailQueue(data.pending || []);
  } catch (e) {
    el.innerHTML = `<div style="color:var(--danger);font-size:.82rem">Could not reach queue: ${e.message}</div>`;
  }
}

function renderEmailQueue(items) {
  emailQueueItems = items;
  const el = document.getElementById('email-queue-list');
  if (!el) return;
  if (!items.length) {
    el.innerHTML = '<div class="muted" style="font-size:.82rem">No pending invoices. Your Gmail queue is clear.</div>';
    return;
  }
  el.innerHTML = items.map((item, idx) => `
    <div style="display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;
                padding:9px 0;border-bottom:1px solid var(--border)">
      <div>
        <strong>${item.supplierName}</strong>
        <span class="badge bb" style="margin-left:6px;font-size:.72rem">${item.extractedJson.length} items</span>
        <div class="muted" style="font-size:.74rem;margin-top:2px">${item.filename} &nbsp;·&nbsp; received ${item.receivedDate}</div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="skipEmailInvoice(${idx}, this)">Skip</button>
      <button class="btn btn-primary btn-sm" onclick="openEmailInvoice(${idx})">Review →</button>
    </div>`).join('');
}

async function skipEmailInvoice(idx, btn) {
  const item = emailQueueItems[idx];
  const url  = localStorage.getItem('rcc-gmail-webapp-url');
  if (!url || !item) return;
  btn.disabled = true; btn.textContent = '…';
  try {
    await fetch(url, { method: 'POST', body: JSON.stringify({ id: item.id, action: 'skipped' }) });
    emailQueueItems.splice(idx, 1);
    renderEmailQueue(emailQueueItems);
    toast('Invoice skipped.');
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Skip';
    toast('Failed: ' + e.message, 'error');
  }
}

function openEmailInvoice(idx) {
  const item = emailQueueItems[idx];
  if (!item) return;

  // Auto-match supplier by name
  let supplierId = '';
  const matchedSup = (db.suppliers || []).find(s =>
    s.name.toLowerCase().includes(item.supplierName.toLowerCase()) ||
    item.supplierName.toLowerCase().includes(s.name.toLowerCase())
  );
  if (matchedSup) supplierId = matchedSup.id;

  // Populate wizard state, skipping straight to step 3
  wiz = {
    file:         { name: item.filename },
    supplierId,
    extracted:    item.extractedJson,
    matched:      item.extractedJson.map(r => ({ ...r, userIngredientId: null })),
    step:         1,
    emailQueueId: item.id
  };

  document.getElementById('wizard-title').textContent = `Email Invoice — ${item.supplierName}: ${item.filename}`;
  openModal('modal-invoice-wizard');

  // Run AI ingredient matching (step 2), then show review (step 3)
  setWizardStep(2);
  document.getElementById('wizard-content').innerHTML =
    `<div class="ai-box ai-thinking">🤖 Matching ${item.extractedJson.length} items to your ingredient library…</div>`;
  document.getElementById('wizard-footer').innerHTML = '';

  wizardMatch().catch(() => {
    wiz.matched = wiz.extracted.map(r => ({ ...r, userIngredientId: null }));
    setWizardStep(3); renderWizardStep3();
  });
}

// ── BULK CSV IMPORT ───────────────────────────────────────────────────────────
// Upload a multi-invoice CSV → AI matches ALL unique products at once →
// single review table → one approve that imports every purchase row.
//
// CSV columns: Supplier, Invoice No, Invoice Date, Product Name, Buy Unit,
//              Qty, Total Price ($), Pack Count, Pack Size, Pack Unit

let bulkCSVState = null;
// bulkCSVState = { rows: [...all purchase rows...],
//                  uniqueItems: [{ key, name, rows, matchedIngredientId }] }

async function startBulkCSVImport(input) {
  const file = input.files[0]; if (!file) return; input.value = '';
  const st   = document.getElementById('bulk-csv-status');
  const show = msg => { if (st) { st.style.display = 'block'; st.textContent = msg; } };
  const hide = ()   => { if (st) st.style.display = 'none'; };

  show('🔄 Parsing CSV…');
  try {
    const text = await file.text();
    const rows = parseBulkCSVRows(text);
    if (!rows.length) { hide(); toast('No rows found in CSV.', 'warn'); return; }

    // Unique product names (case-insensitive dedup, preserve first-seen casing)
    const uniqueMap = {};
    rows.forEach(r => {
      const key = r.name.toLowerCase().trim();
      if (!uniqueMap[key]) uniqueMap[key] = { key, name: r.name, rows: [] };
      uniqueMap[key].rows.push(r);
    });
    const uniqueItems = Object.values(uniqueMap).map(u => ({ ...u, matchedIngredientId: null }));

    show(`🤖 AI matching ${uniqueItems.length} unique products to your ingredient library…`);

    // Single AI call for all unique names
    if (db.ingredients.length > 0) {
      const ingList = db.ingredients.map(i => ({ id: i.id, name: i.name }));
      const prompt =
        `Match each invoice product to the closest ingredient in the library.\n` +
        `Return ONLY a JSON array: [{"invoiceIndex":0,"suggestedIngredientId":"id_or_null"}]\n` +
        `Set suggestedIngredientId to null if there is no reasonable match.\n\n` +
        `Invoice products:\n` + uniqueItems.map((u, i) => `${i}. "${u.name}"`).join('\n') + `\n\n` +
        `Library:\n` + ingList.map(i => `id:"${i.id}" name:"${i.name}"`).join('\n');

      const res  = await claudePost({ model: 'claude-sonnet-4-20250514', max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }] });
      const d    = await res.json();
      const txt  = d.content?.map(x => x.text || '').join('').replace(/```json|```/g, '').trim();
      const sugg = JSON.parse(txt);
      sugg.forEach(s => {
        if (s.invoiceIndex >= 0 && s.invoiceIndex < uniqueItems.length)
          uniqueItems[s.invoiceIndex].matchedIngredientId = s.suggestedIngredientId || null;
      });
    }

    bulkCSVState = { rows, uniqueItems };
    hide();
    renderBulkCSVModal();
    openModal('modal-bulk-csv');

  } catch(e) {
    show('❌ Error: ' + e.message);
  }
}

function parseBulkCSVRows(text) {
  const lines = text.trim().split('\n');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 10) continue;
    const [supplier, invoiceNo, date, name, buyUnit, qty, totalPrice, packCount, packSize, packUnit] =
      cols.map(c => c.trim());
    if (!name) continue;
    const pu = csvNormPackUnit(packUnit);
    const bu = csvNormBuyUnit(buyUnit);
    const dp = date.split('/');
    out.push({
      supplier, invoiceNo,
      date: dp.length === 3 ? `${dp[2]}-${dp[1].padStart(2,'0')}-${dp[0].padStart(2,'0')}` : date,
      name,
      buy_unit:    bu,
      buy_qty:     parseFloat(qty) || 1,
      total_price: parseFloat(totalPrice.replace(/,/g, '')) || 0,
      pack_count:  parseFloat(packCount) || null,
      pack_size:   parseFloat(packSize)  || null,
      pack_unit:   pu,
      recipe_unit: csvRecipeUnit(pu)
    });
  }
  return out;
}

function csvNormBuyUnit(u) {
  u = (u || '').toLowerCase();
  if (['lt','l','litre','liter'].includes(u)) return 'L';
  if (['drum','pack'].includes(u))            return 'each';
  return u;
}
function csvNormPackUnit(u) {
  u = (u || '').toLowerCase();
  if (['lt','l','litre','liter'].includes(u)) return 'L';
  return u;
}
function csvRecipeUnit(pu) {
  if (pu === 'kg' || pu === 'g')  return 'g';
  if (pu === 'L'  || pu === 'ml') return 'ml';
  return 'each';
}

function renderBulkCSVModal() {
  const { uniqueItems, rows } = bulkCSVState;
  const matched    = uniqueItems.filter(u => u.matchedIngredientId).length;
  const unmatched  = uniqueItems.length - matched;
  const totalSpend = rows.reduce((s, r) => s + r.total_price, 0);

  const ingOpts = '<option value="">— Skip (don\'t import) —</option>' +
    '<option value="__new__">＋ Create as new ingredient</option>' +
    db.ingredients.map(i => `<option value="${i.id}">${i.name} (${i.recipeUnit})</option>`).join('');

  document.getElementById('bulk-csv-modal-content').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
      <div class="stat" style="padding:10px">
        <div class="stat-val" style="font-size:1.1rem">${rows.length}</div>
        <div class="stat-label">Purchase rows</div>
      </div>
      <div class="stat" style="padding:10px">
        <div class="stat-val" style="font-size:1.1rem">${uniqueItems.length}</div>
        <div class="stat-label">Unique products</div>
      </div>
      <div class="stat" style="padding:10px">
        <div class="stat-val" style="font-size:1.1rem;color:var(--accent2)">${matched}</div>
        <div class="stat-label">AI matched</div>
      </div>
      <div class="stat" style="padding:10px">
        <div class="stat-val" style="font-size:1.1rem;color:var(--warn)">${unmatched}</div>
        <div class="stat-label">Unmatched → will create new</div>
      </div>
    </div>
    <div style="font-size:.78rem;color:var(--muted);margin-bottom:8px">
      Review AI matches. Unmatched items default to <strong>Create as new ingredient</strong>.
      Change to <em>Skip</em> for anything you don't want imported (e.g. non-food supplies).
    </div>
    <div style="overflow-x:auto;max-height:420px;overflow-y:auto">
      <table style="font-size:.79rem">
        <thead><tr>
          <th>Product Name</th><th>Supplier(s)</th>
          <th style="text-align:center">Purchases</th>
          <th style="text-align:right">Total Spend</th>
          <th>Link to Ingredient</th>
        </tr></thead>
        <tbody>
          ${uniqueItems.map((u, idx) => {
            const suppliers = [...new Set(u.rows.map(r => r.supplier))].join(', ');
            const spend     = u.rows.reduce((s, r) => s + r.total_price, 0);
            const selVal    = u.matchedIngredientId || '__new__';
            return `<tr style="${!u.matchedIngredientId ? 'background:rgba(255,217,61,.04)' : ''}">
              <td><strong>${u.name}</strong></td>
              <td style="color:var(--muted);font-size:.75rem">${suppliers}</td>
              <td style="text-align:center">${u.rows.length}</td>
              <td style="text-align:right">$${fmt(spend)}</td>
              <td>
                <select style="font-size:.76rem;min-width:220px" onchange="setBulkMatch(${idx},this.value)">
                  ${ingOpts.replace(`value="${selVal}"`, `value="${selVal}" selected`)}
                </select>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div style="font-size:.78rem;color:var(--muted);margin-top:10px">
      Total across all invoices: <strong>$${fmt(totalSpend)}</strong>
    </div>`;

  document.getElementById('bulk-csv-modal-footer').innerHTML =
    `<button class="btn btn-ghost" onclick="closeModal('modal-bulk-csv')">Cancel</button>
     <button class="btn btn-success" onclick="approveBulkCSVImport()">✓ Approve & Import All</button>`;
}

function setBulkMatch(idx, val) {
  if (bulkCSVState) bulkCSVState.uniqueItems[idx].matchedIngredientId = val || null;
}

function approveBulkCSVImport() {
  const { rows, uniqueItems } = bulkCSVState;

  // Resolve name → ingredient ID (create new ingredients where "__new__")
  const nameToIngId = {};
  uniqueItems.forEach(u => {
    if (!u.matchedIngredientId) return; // skip
    if (u.matchedIngredientId === '__new__') {
      const sample = u.rows[0];
      const newIng = {
        id: uid(), name: u.name, category: '',
        supplierId: getOrCreateSupplierByName(sample.supplier),
        recipeUnit: sample.recipe_unit || 'g',
        yield: 100, costImpact: '',
        wac: 0, totalBaseUnits: 0, purchases: []
      };
      if (!db.ingredients) db.ingredients = [];
      db.ingredients.push(newIng);
      nameToIngId[u.key] = newIng.id;
    } else {
      nameToIngId[u.key] = u.matchedIngredientId;
    }
  });

  // Add purchase records; accumulate importLog entries by invoice
  const invoiceLog = {};
  let totalAdded = 0;
  rows.forEach(r => {
    const ingId = nameToIngId[r.name.toLowerCase().trim()]; if (!ingId) return;
    const ing   = db.ingredients.find(x => x.id === ingId);  if (!ing)  return;
    const cpu   = calcCPU(r.total_price, r.buy_qty, r.pack_count, r.pack_size, r.pack_unit, r.buy_unit);
    if (!cpu) return;
    const baseUnits = getBaseUnits(r.buy_qty, r.pack_count, r.pack_size, r.pack_unit, r.buy_unit);
    const supId     = getOrCreateSupplierByName(r.supplier);
    if (!ing.purchases) ing.purchases = [];
    ing.purchases.push({
      id: uid(), date: r.date, supplierId: supId,
      invoiceNo: r.invoiceNo || null,
      buyUnit: r.buy_unit, buyQty: r.buy_qty,
      packCount: r.pack_count || null, packSize: r.pack_size || null, packUnit: r.pack_unit,
      totalPrice: r.total_price, cpru: cpu, baseUnits, obsolete: false
    });
    recalcWAC(ing);
    totalAdded++;

    const lk = `${r.supplier}|||${r.invoiceNo}`;
    if (!invoiceLog[lk]) invoiceLog[lk] = { supplier: r.supplier, invoiceNo: r.invoiceNo, date: r.date, supplierId: supId, matchedCount: 0, totalValue: 0 };
    invoiceLog[lk].matchedCount++;
    invoiceLog[lk].totalValue += r.total_price;
  });

  if (!db.importLog) db.importLog = [];
  Object.values(invoiceLog).forEach(l => {
    db.importLog.push({
      id: uid(), date: l.date, filename: l.invoiceNo, invoiceNo: l.invoiceNo,
      type: 'invoice', supplierId: l.supplierId, supplierName: l.supplier,
      itemCount: l.matchedCount, matchedCount: l.matchedCount,
      skippedItems: [], totalValue: l.totalValue, status: 'approved'
    });
  });

  saveDB(); closeModal('modal-bulk-csv'); renderIngredients(); renderImportLog();
  const newCount = uniqueItems.filter(u => u.matchedIngredientId === '__new__').length;
  toast(`Bulk import done: ${totalAdded} purchases added${newCount ? `, ${newCount} new ingredients created` : ''}.`);
  bulkCSVState = null;
}

function getOrCreateSupplierByName(name) {
  if (!db.suppliers) db.suppliers = [];
  let s = db.suppliers.find(x => x.name.toLowerCase() === name.toLowerCase());
  if (!s) { s = { id: uid(), name, contact: '', email: '', phone: '', notes: '' }; db.suppliers.push(s); }
  return s.id;
}

// ── SETTINGS HELPERS ─────────────────────────────────────────────────────────
function getDeliveryCommission() {
  return parseFloat(localStorage.getItem('rcc-delivery-commission') || '37') / 100;
}
function getDeliveryChannel() {
  return localStorage.getItem('rcc-delivery-channel') || 'Doshii';
}

// ── AI API HELPER ────────────────────────────────────────────────────────────
function getApiKey() { return localStorage.getItem('rcc-api-key') || ''; }

function claudePost(body) {
  const key = getApiKey();
  if (!key) {
    openModal('modal-settings');
    throw new Error('API key required — enter it in Settings, then try again.');
  }
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });
}

// ── MODIFIER LINKS (persisted in db) ─────────────────────────────────────────
// db.modifierLinks = [{ pattern, type, ingredientId, qty, unit, extraCost }, ...]
// pattern:      exact modifier text from CSV (e.g. "+ Extra Bufala Cheese")
// type:         "add" (+ prefix) | "remove" (No prefix) | "neutral"
// ingredientId: links to ingredient for inventory deduction per serving
// qty / unit:   deduction amount
// extraCost:    manual fallback cost — only used when no ingredient is linked

// Returns the extra food cost per serving for a modifier string.
// When an ingredient is linked, cost = effectiveCost(ingredient) × qty (auto).
// When no ingredient is linked, falls back to the manual extraCost field.
function getModifierExtraCost(modifierStr) {
  if (!modifierStr || !db.modifierLinks || !db.modifierLinks.length) return 0;
  const parts = modifierStr.split(',').map(s => s.trim().toLowerCase());
  return (db.modifierLinks).reduce((sum, ml) => {
    if (parts.some(p => p === ml.pattern.toLowerCase())) {
      if (ml.ingredientId && ml.qty) {
        const ing = db.ingredients.find(i => i.id === ml.ingredientId);
        if (ing) return sum + effectiveCost(ing) * (ml.qty || 0);
      }
      return sum + (parseFloat(ml.extraCost) || 0);
    }
    return sum;
  }, 0);
}

function modifierType(pattern) {
  if (pattern.startsWith('+')) return 'add';
  if (pattern.toLowerCase().startsWith('no ')) return 'remove';
  return 'neutral';
}

// ── FUZZY MENU ITEM MATCHING ─────────────────────────────────────────────────
// Square CSV "Item" column = "Garlic Bread - Large 10 Pieces" or "Margherita Pizza"
// Your menu items might be named "Garlic Bread - Large" or just "Garlic Bread"
// Strategy: exact → startsWith → contains → base-name match (strip after ' - ')

function findMenuItemMatch(squareName) {
  const sq = squareName.toLowerCase().trim();

  // 1. Exact match
  let m = db.menuItems.find(x => x.name.toLowerCase().trim() === sq);
  if (m) return { item: m, confidence: 'exact' };

  // 2. Square name starts with menu item name (menu item is a prefix)
  m = db.menuItems.find(x => sq.startsWith(x.name.toLowerCase().trim()));
  if (m) return { item: m, confidence: 'prefix' };

  // 3. Menu item name starts with Square name
  m = db.menuItems.find(x => x.name.toLowerCase().trim().startsWith(sq));
  if (m) return { item: m, confidence: 'prefix' };

  // 4. Strip variation suffix from Square name (everything after ' - ')
  //    e.g. "Garlic Bread - Large 10 Pieces" → "Garlic Bread"
  const baseSq = sq.split(' - ')[0].trim();
  if (baseSq !== sq) {
    m = db.menuItems.find(x => x.name.toLowerCase().trim() === baseSq);
    if (m) return { item: m, confidence: 'variation' };

    m = db.menuItems.find(x => x.name.toLowerCase().trim().startsWith(baseSq));
    if (m) return { item: m, confidence: 'variation' };
  }

  // 5. Contains match (last resort)
  m = db.menuItems.find(x => sq.includes(x.name.toLowerCase().trim()) || x.name.toLowerCase().trim().includes(sq));
  if (m) return { item: m, confidence: 'fuzzy' };

  return { item: null, confidence: 'none' };
}

// ── SQUARE CSV PARSER ────────────────────────────────────────────────────────
function parseSquareCSV(csvText) {
  const lines = csvText.trim().split('\n');
  const headers = parseCSVLine(lines[0]);
  const commission = getDeliveryCommission();
  const deliveryChannel = getDeliveryChannel().toLowerCase();
  const itemMap = {};

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 5) continue;

    const row = {};
    headers.forEach((h, idx) => row[h.trim()] = (cols[idx] || '').trim());

    const item      = row['Item'] || '';
    const variation = row['Price Point Name'] || '';   // Square size/variation column
    const modifiers = row['Modifiers Applied'] || '';  // Square modifiers column
    const channel   = row['Channel'] || '';
    const qty       = parseFloat(row['Qty']) || 0;
    const net       = parseMoney(row['Net Sales']);

    if (!item || item.startsWith('Order ID') || item.startsWith('DELIVERY') || net <= 0 || qty <= 0) continue;

    const isDelivery  = channel.toLowerCase().includes(deliveryChannel);
    const channelType = isDelivery ? 'doshii' : 'square';
    const commissionLost = isDelivery ? net * commission : 0;
    const trueNet        = isDelivery ? net * (1 - commission) : net;

    // Key includes variation AND modifiers so each unique combination is a separate line.
    // Modifiers are sorted so "A, B" and "B, A" group together.
    const varLabel  = variation || '';
    const normMods  = modifiers ? modifiers.split(',').map(s => s.trim()).sort().join('|') : '';
    const key = `${item}|||${varLabel}|||${channelType}|||${normMods}`;

    if (!itemMap[key]) {
      itemMap[key] = {
        squareName:   item,        // raw Square item name
        variation:    varLabel,    // Price Point Name (size, etc.)
        modifiers:    modifiers,   // raw modifier string as-is for display/lookup
        channel:      channelType,
        channelLabel: isDelivery ? 'Doshii' : 'Square',
        qty:          0,
        grossRevenue: 0,
        trueRevenue:  0,
        commissionLost: 0,
        menuItemId:   null,
        matchConfidence: 'none'
      };
    }
    itemMap[key].qty            += qty;
    itemMap[key].grossRevenue   += net;
    itemMap[key].trueRevenue    += trueNet;
    itemMap[key].commissionLost += commissionLost;
  }

  // Now pre-match each item to a menu item
  const results = Object.values(itemMap);
  results.forEach(r => {
    // Try full "Item - Variation" first, then just Item
    const fullName = r.variation ? `${r.squareName} - ${r.variation}` : r.squareName;
    let match = findMenuItemMatch(fullName);
    if (match.confidence === 'none') match = findMenuItemMatch(r.squareName);
    r.menuItemId      = match.item ? match.item.id : null;
    r.matchConfidence = match.confidence;
    // Display name shown in review table
    r.displayName = r.variation ? `${r.squareName} — ${r.variation}` : r.squareName;
  });

  return results;
}

// Robust CSV parser — handles quoted fields with commas inside
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

function parseMoney(str) {
  return parseFloat((str || '0').replace(/[$,]/g, '')) || 0;
}

// ── SQUARE ORDERS API PARSER ─────────────────────────────────────────────────
// Transforms Orders API response into same shape as parseSquareCSV() output
// so renderSquareSalesReview() can be reused unchanged.
function parseSquareOrders(orders) {
  const commission     = getDeliveryCommission();
  const deliveryChannel = getDeliveryChannel().toLowerCase();
  const itemMap = {};

  for (const order of (orders || [])) {
    // For OPEN orders (Doshii/Uber Eats), only count if the fulfillment was actually PREPARED.
    // Skips abandoned Square Online orders (DRAFT/CANCELLED) and other unfulfilled OPEN orders.
    if (order.state === 'OPEN') {
      const fulfilled = (order.fulfillments || []).some(f => f.state === 'PREPARED' || f.state === 'COMPLETED');
      if (!fulfilled) continue;
    }

    // Channel detection: source name or tender source must explicitly match the delivery channel name
    const sourceName      = (order.source && order.source.name || '').toLowerCase();
    const tenderSource    = (order.tenders && order.tenders[0] && order.tenders[0].other_details && order.tenders[0].other_details.source || '').toLowerCase();
    const isDelivery = deliveryChannel
      && (sourceName.includes(deliveryChannel) || tenderSource.includes(deliveryChannel));
    const channelType  = isDelivery ? 'doshii' : 'square';
    const channelLabel = isDelivery ? 'Doshii' : 'Square';

    // Extract order date (YYYY-MM-DD) from created_at timestamp
    const orderDate = (order.created_at || '').slice(0, 10);

    for (const li of (order.line_items || [])) {
      const name      = li.name || '';
      const variation = li.variation_name || '';
      if (!name) continue;

      const qty     = parseInt(li.quantity) || 0;
      // gross_sales_money = item price × qty, ex-discounts, GST-inclusive
      // net_sales_money   = ex-discounts, ex-GST — matches Square CSV "Net Sales"
      const grossAmt    = (li.gross_sales_money && li.gross_sales_money.amount) || 0;
      const netSalesAmt = (li.net_sales_money   && li.net_sales_money.amount)   != null
                          ? li.net_sales_money.amount : grossAmt;
      const gross       = grossAmt / 100;
      const net         = netSalesAmt / 100;

      if (qty <= 0 || net <= 0) continue;

      const commissionLost = isDelivery ? net * commission : 0;
      const trueNet        = isDelivery ? net * (1 - commission) : net;
      const modifiers      = (li.modifiers || []).map(m => m.name).filter(Boolean).join(', ');
      const normMods       = modifiers ? modifiers.split(',').map(s => s.trim()).sort().join('|') : '';
      // Include date in key so each day gets its own row
      const key            = `${orderDate}|||${name}|||${variation}|||${channelType}|||${normMods}`;

      if (!itemMap[key]) {
        itemMap[key] = {
          date: orderDate,
          squareName: name, variation, modifiers,
          channel: channelType, channelLabel,
          qty: 0, grossRevenue: 0, trueRevenue: 0, commissionLost: 0,
          menuItemId: null, matchConfidence: 'none'
        };
      }
      itemMap[key].qty            += qty;
      itemMap[key].grossRevenue   += gross;
      itemMap[key].trueRevenue    += trueNet;
      itemMap[key].commissionLost += commissionLost;
      if (modifiers && !itemMap[key].modifiers) itemMap[key].modifiers = modifiers;
    }
  }

  // Pre-match each item to a menu item (same logic as parseSquareCSV)
  const results = Object.values(itemMap);
  results.forEach(r => {
    const fullName = r.variation ? `${r.squareName} - ${r.variation}` : r.squareName;
    let match = findMenuItemMatch(fullName);
    if (match.confidence === 'none') match = findMenuItemMatch(r.squareName);
    r.menuItemId      = match.item ? match.item.id : null;
    r.matchConfidence = match.confidence;
    r.displayName     = r.variation ? `${r.squareName} — ${r.variation}` : r.squareName;
  });

  return results;
}

// ── RAW ORDERS CSV EXPORT (debug / analysis) ─────────────────────────────────
function downloadRawOrdersCSV(orders, from, to) {
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const headers = [
    'order_id','order_date','source','fulfillment_type',
    'item_name','variation_name','quantity',
    'base_price_aud','gross_sales_aud','gst_aud','net_ex_gst_aud','total_money_aud',
    'modifiers','currency'
  ];
  const rows = [headers.map(esc).join(',')];

  for (const o of orders) {
    const date = (o.created_at || '').slice(0, 10);
    const source = (o.source && o.source.name) || '';
    const fulfillment = (o.fulfillments && o.fulfillments[0] && o.fulfillments[0].type) || '';

    for (const li of (o.line_items || [])) {
      const grossAmt = (li.gross_sales_money && li.gross_sales_money.amount) || 0;
      const taxAmt   = (li.total_tax_money   && li.total_tax_money.amount)   || 0;
      const mods     = (li.modifiers || []).map(m => m.name).filter(Boolean).join('; ');
      rows.push([
        esc(o.id), esc(date), esc(source), esc(fulfillment),
        esc(li.name || ''), esc(li.variation_name || ''), esc(li.quantity || ''),
        esc((((li.base_price_money && li.base_price_money.amount) || 0) / 100).toFixed(2)),
        esc((grossAmt / 100).toFixed(2)),
        esc((taxAmt / 100).toFixed(2)),
        esc(((grossAmt - taxAmt) / 100).toFixed(2)),
        esc((((li.total_money && li.total_money.amount) || 0) / 100).toFixed(2)),
        esc(mods),
        esc((li.gross_sales_money && li.gross_sales_money.currency) || 'AUD')
      ].join(','));
    }
  }

  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(rows.join('\n'));
  a.download = `square-raw-${from}-to-${to}.csv`;
  a.click();
}

// ── SQUARE DIRECT API FETCH ───────────────────────────────────────────────────
async function fetchFromSquare(from, to) {
  const token      = localStorage.getItem('rcc-square-token') || '';
  const locationId = localStorage.getItem('rcc-square-location') || '';

  const locationIds = locationId.split(',').map(s => s.trim()).filter(Boolean);
  if (!token || !locationIds.length) {
    alert('Enter Square Access Token and Location ID(s) in Settings first (⚙ icon).');
    openModal('modal-settings');
    return;
  }

  const btn = document.getElementById('sq-fetch-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Fetching…'; }

  try {
    // Build timezone-aware RFC 3339 timestamps
    const offset = -new Date().getTimezoneOffset();
    const sign   = offset >= 0 ? '+' : '-';
    const hh     = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
    const mm     = String(Math.abs(offset) % 60).padStart(2, '0');
    const tz     = `${sign}${hh}:${mm}`;

    const resp = await fetch('/api/square-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, locationIds, from: `${from}T00:00:00${tz}`, to: `${to}T23:59:59${tz}` })
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Server error');

    const orders = data.orders || [];
    if (!orders.length) { toast('No orders found in that date range.', 'warn'); return; }

    const salesData = parseSquareOrders(orders);
    if (!salesData.length) { toast('No sales line items found.', 'warn'); return; }

    if (!db.modifierLinks) db.modifierLinks = [];
    pendingSalesImport = { file: { name: `Square API ${from} → ${to}` }, data: salesData, isSquare: true, dateFrom: from, dateTo: to };
    document.getElementById('sales-ai-status').style.display = 'none';
    document.getElementById('sales-ai-content').innerHTML = '';
    renderSquareSalesReview(salesData);
    document.getElementById('sales-ai-approve').style.display = 'inline-block';
    openModal('modal-sales-ai');

  } catch (e) {
    alert('Square fetch failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Fetch from Square'; }
  }
}

// ── SQUARE SALES IMPORT ──────────────────────────────────────────────────────
async function startSalesImport(input) {
  const file = input.files[0]; if (!file) return; input.value = '';

  const dup = db.importLog.find(l => l.filename === file.name && l.type === 'sales');
  if (dup && !confirm(`"${file.name}" already imported on ${dup.date}. Continue?`)) return;

  const st      = document.getElementById('sales-ai-status');
  const content = document.getElementById('sales-ai-content');

  st.style.display = 'block';
  st.className     = 'ai-box ai-thinking';
  st.textContent   = '📊 Reading Square CSV…';
  content.innerHTML = '';
  document.getElementById('sales-ai-approve').style.display = 'none';
  openModal('modal-sales-ai');

  try {
    const text = await file.text();
    const firstLine = text.split('\n')[0];
    const isSquareCSV = firstLine.includes('Net Sales') && firstLine.includes('Channel') && firstLine.includes('Gross Sales');

    if (!isSquareCSV) {
      throw new Error('This does not look like a Square items CSV. Export the "Items" report from Square Dashboard → Reports → Sales.');
    }

    const parsed = parseSquareCSV(text);
    if (!parsed.length) throw new Error('No valid sales rows found.');

    if (!db.modifierLinks) db.modifierLinks = [];

    pendingSalesImport = { file, data: parsed, isSquare: true };
    st.style.display = 'none';
    renderSquareSalesReview(parsed);
    document.getElementById('sales-ai-approve').style.display = 'inline-block';

  } catch(e) {
    st.className   = 'ai-box ai-error';
    st.textContent = '❌ ' + e.message;
  }
}

// ── CONFIDENCE BADGE ─────────────────────────────────────────────────────────
function confidenceBadge(c) {
  if (c === 'exact')     return `<span class="badge bg">✓ Exact</span>`;
  if (c === 'prefix')    return `<span class="badge bg">✓ Matched</span>`;
  if (c === 'variation') return `<span class="badge bg">✓ Variation</span>`;
  if (c === 'fuzzy')     return `<span class="badge bw">~ Fuzzy</span>`;
  return `<span class="badge br">✗ No match</span>`;
}

// ── RENDER REVIEW MODAL ──────────────────────────────────────────────────────
function renderSquareSalesReview(data) {
  const commission     = getDeliveryCommission();
  const totalDineIn    = data.filter(r => r.channel === 'square').reduce((s, r) => s + r.trueRevenue, 0);
  const totalDelivery  = data.filter(r => r.channel === 'doshii').reduce((s, r) => s + r.trueRevenue, 0);
  const totalCommLost  = data.reduce((s, r) => s + r.commissionLost, 0);
  const matched        = data.filter(r => r.menuItemId).length;
  const unmatched      = data.length - matched;

  // Collect unique modifiers across all rows
  const allModifiers = [...new Set(
    data.flatMap(r => r.modifiers ? r.modifiers.split(',').map(s => s.trim()).filter(Boolean) : [])
  )].sort();

  const menuOpts = '<option value="">— Unlinked (revenue only) —</option>' +
    db.menuItems.map(m => {
      const rec = db.recipes.find(r => r.id === m.recipeId);
      return `<option value="${m.id}">${m.name}${rec ? '' : ' ⚠ no recipe'}</option>`;
    }).join('');

  document.getElementById('sales-ai-content').innerHTML = `
    <div style="background:rgba(78,204,163,.08);border:1px solid rgba(78,204,163,.25);border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:.82rem;">
      📊 <strong style="color:var(--accent2)">Square CSV parsed</strong> — ${data.length} line item(s).
      <strong style="color:var(--accent2)">${matched}</strong> matched to menu recipes,
      <strong style="color:${unmatched > 0 ? 'var(--warn)' : 'var(--accent2)'}"> ${unmatched} unlinked</strong>.
    </div>

    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
      <div class="stat" style="padding:10px">
        <div class="stat-val" style="font-size:1.1rem;color:var(--accent2)">$${fmt(totalDineIn)}</div>
        <div class="stat-label">Square Net Sales</div>
      </div>
      <div class="stat" style="padding:10px">
        <div class="stat-val" style="font-size:1.1rem;color:var(--accent2)">$${fmt(totalDelivery)}</div>
        <div class="stat-label">Doshii Net (after ${(commission*100).toFixed(0)}% comm.)</div>
      </div>
      <div class="stat" style="padding:10px">
        <div class="stat-val" style="font-size:1.1rem;color:var(--accent2)">$${fmt(totalDineIn + totalDelivery)}</div>
        <div class="stat-label">Total True Revenue</div>
      </div>
      <div class="stat" style="padding:10px">
        <div class="stat-val" style="font-size:1.1rem;color:var(--danger)">$${fmt(totalCommLost)}</div>
        <div class="stat-label">Lost to Commission</div>
      </div>
    </div>

    ${allModifiers.length > 0 ? (() => {
      const linked   = allModifiers.filter(m => (db.modifierLinks||[]).some(ml => ml.pattern.toLowerCase() === m.toLowerCase() && ml.ingredientId));
      const unlinked = allModifiers.filter(m => !linked.includes(m));
      return `<div style="background:rgba(108,99,255,.08);border:1px solid rgba(108,99,255,.25);border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:.82rem">
        🔧 <strong style="color:var(--accent)">${allModifiers.length} modifier${allModifiers.length !== 1 ? 's' : ''} in this import</strong>
        — <span style="color:var(--accent2)">${linked.length} linked to ingredients</span>${unlinked.length ? `, <span style="color:var(--warn)">${unlinked.length} unlinked (${unlinked.map(m=>`<em>${m}</em>`).join(', ')})</span>` : ''}.
        <span class="muted">Edit ingredient links in the <strong>Modifiers</strong> section on the Menu page.</span>
      </div>`;
    })() : ''}

    <div style="font-weight:600;font-size:.8rem;margin-bottom:6px">
      SALES LINES — review menu item links before approving
    </div>
    <div style="overflow-x:auto;max-height:340px;overflow-y:auto">
      <table style="font-size:.79rem">
        <thead>
          <tr>
            <th>Square Item / Variation</th>
            <th>Modifiers</th>
            <th>Channel</th>
            <th>Qty</th>
            <th>True Revenue</th>
            <th>Match</th>
            <th>Link to Menu Item</th>
          </tr>
        </thead>
        <tbody>
          ${[...data].sort((a,b) => b.trueRevenue - a.trueRevenue).map((r) => {
            const idx = data.indexOf(r);
            return `<tr style="${!r.menuItemId ? 'background:rgba(255,217,61,.04)' : ''}">
              <td>
                <strong>${r.squareName}</strong>
                ${r.variation ? `<div class="muted">Variation: ${r.variation}</div>` : ''}
              </td>
              <td style="color:var(--accent);font-size:.75rem">${r.modifiers || '—'}</td>
              <td><span class="badge ${r.channel === 'square' ? 'bg' : 'bp'}">${r.channelLabel}</span></td>
              <td>${r.qty}</td>
              <td><strong style="color:var(--accent2)">$${fmt(r.trueRevenue)}</strong></td>
              <td>${confidenceBadge(r.matchConfidence)}</td>
              <td>
                <select style="font-size:.77rem;min-width:180px"
                  onchange="updateSalesLink(${idx}, this.value)">
                  ${menuOpts}
                </select>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  // Set dropdowns to pre-matched values
  const selects = document.querySelectorAll('#sales-ai-content tbody select');
  [...data].sort((a,b) => b.trueRevenue - a.trueRevenue).forEach((r, si) => {
    if (r.menuItemId && selects[si]) selects[si].value = r.menuItemId;
  });
}

function updateSalesLink(idx, menuItemId) {
  if (pendingSalesImport && pendingSalesImport.data[idx]) {
    pendingSalesImport.data[idx].menuItemId      = menuItemId || null;
    pendingSalesImport.data[idx].matchConfidence = menuItemId ? 'manual' : 'none';
  }
}

function updateModifierLink(field, modName, val) {
  if (!db.modifierLinks) db.modifierLinks = [];
  let link = db.modifierLinks.find(ml => ml.pattern.toLowerCase() === modName.toLowerCase());
  if (!link) {
    link = { pattern: modName, type: modifierType(modName), ingredientId: null, qty: 0, unit: 'g', extraCost: 0 };
    db.modifierLinks.push(link);
  }
  if (field === 'qty' || field === 'extraCost') {
    link[field] = parseFloat(val) || 0;
  } else {
    link[field] = val;
  }
  // Remove entries with no data at all
  db.modifierLinks = db.modifierLinks.filter(ml => ml.ingredientId || ml.extraCost > 0 || ml.qty > 0);
}

// ── APPROVE SALES IMPORT ──────────────────────────────────────────────────────
function approveSalesImport() {
  const { data, isSquare, dateFrom, dateTo } = pendingSalesImport;

  // Deduplication: check if we already imported this date range
  if (isSquare && dateFrom && dateTo) {
    const alreadyImported = db.sales.some(s => s.squareDateFrom === dateFrom && s.squareDateTo === dateTo);
    if (alreadyImported) {
      if (!confirm(`Sales for ${dateFrom} → ${dateTo} have already been imported. Import again and create duplicates?`)) return;
    }
  }

  // Save modifier costs to db
  saveDB();

  // saleDate used as fallback for CSV imports (no per-row date)
  const saleDate = dateFrom || todayStr();

  let imported = 0, linkedCount = 0, totalRev = 0;

  if (isSquare) {
    data.forEach(r => {
      if (!r.squareName || !r.qty) return;

      // Find or create menu item
      let menuItem = r.menuItemId ? db.menuItems.find(x => x.id === r.menuItemId) : null;

      if (!menuItem) {
        // Create a placeholder menu item so revenue is tracked
        const displayName = r.variation ? `${r.squareName} - ${r.variation}` : r.squareName;
        menuItem = {
          id: uid(),
          name: displayName,
          price: r.qty > 0 ? r.trueRevenue / r.qty : 0,
          recipeId: '',
          category: ''
        };
        db.menuItems.push(menuItem);
        r.menuItemId = menuItem.id;
      }

      const rev = r.trueRevenue;
      totalRev += rev;

      // Get recipe cost snapshot
      const rec  = db.recipes.find(x => x.id === menuItem.recipeId);
      const baseSnap = rec ? calcRecipeCost(rec.lines, true) : 0;

      // Add modifier extra cost (per unit sold)
      const modExtraCost = getModifierExtraCost(r.modifiers);
      const snap = baseSnap + modExtraCost;

      if (rec) linkedCount++;

      db.sales.push({
        id:             uid(),
        date:           r.date || saleDate,
        squareDateFrom: dateFrom || null,
        squareDateTo:   dateTo   || null,
        itemId:         menuItem.id,
        qty:            r.qty,
        revenue:        rev,
        snapshotCost:   snap,
        channel:        r.channel,
        channelLabel:   r.channelLabel,
        grossRevenue:   r.grossRevenue,
        commissionLost: r.commissionLost,
        squareName:     r.squareName,
        variation:      r.variation,
        modifiers:      r.modifiers,
        modifierExtraCost: modExtraCost
      });
      imported++;
    });
  } else {
    // Legacy fallback
    data.forEach(r => {
      if (!r.name || !r.qty_sold) return;
      let m = db.menuItems.find(x => x.name.toLowerCase() === r.name.toLowerCase());
      if (!m) { m = { id: uid(), name: r.name, price: r.selling_price||0, recipeId: '', category: '' }; db.menuItems.push(m); }
      const rev = (r.selling_price||0) * r.qty_sold; totalRev += rev;
      const rec  = db.recipes.find(x => x.id === m.recipeId);
      const snap = rec ? calcRecipeCost(rec.lines, true) : 0;
      db.sales.push({ id: uid(), date: todayStr(), itemId: m.id, qty: r.qty_sold, revenue: rev, snapshotCost: snap, channel: 'square', channelLabel: 'Square' });
      imported++;
    });
  }

  db.importLog.push({
    id:           uid(),
    date:         todayStr(),
    filename:     pendingSalesImport.file.name,
    type:         'sales',
    supplierName: 'Square',
    itemCount:    data.length,
    matchedCount: imported,
    linkedCount:  linkedCount,
    totalValue:   totalRev,
    status:       'approved',
    data:         JSON.parse(JSON.stringify(data))
  });

  // Auto-create modifier link stubs for any new modifiers not yet in the library
  if (!db.modifierLinks) db.modifierLinks = [];
  let newModCount = 0;
  const allModsInImport = new Set();
  data.forEach(r => {
    if (r.modifiers) r.modifiers.split(',').map(s => s.trim()).filter(Boolean).forEach(m => allModsInImport.add(m));
  });
  allModsInImport.forEach(mod => {
    if (!db.modifierLinks.some(ml => ml.pattern.toLowerCase() === mod.toLowerCase())) {
      db.modifierLinks.push({ pattern: mod, type: modifierType(mod), ingredientId: null, qty: 0, unit: 'g', extraCost: 0 });
      newModCount++;
    }
  });

  saveDB();
  closeModal('modal-sales-ai');
  renderSales();
  renderModifierLinks();
  renderImportLog();

  const unlinked = imported - linkedCount;
  let msg = `Square import: ${imported} items, $${fmt(totalRev)} revenue.`;
  if (linkedCount > 0) msg += ` ${linkedCount} with recipe cost.`;
  if (unlinked > 0)    msg += ` ${unlinked} unlinked — add recipes via Menu tab.`;
  if (newModCount > 0) msg += ` ${newModCount} new modifier${newModCount !== 1 ? 's' : ''} added to Menu → Modifiers.`;
  toast(msg);
}

// ── INVOICE WIZARD ───────────────────────────────────────────────────────────
function setWizardStep(n) {
  wiz.step = n;
  [1,2,3,4].forEach(i => {
    const el = document.getElementById('ws'+i);
    el.className = 'step' + (i < n ? ' done' : i === n ? ' active' : '');
  });
}

async function startInvoiceImport(input) {
  const file = input.files[0]; if (!file) return; input.value = '';
  const dup = db.importLog.find(l => l.filename === file.name && l.type === 'invoice');
  if (dup && !confirm(`"${file.name}" was already imported on ${dup.date}. Continue?`)) return;
  wiz = { file, supplierId: '', extracted: [], matched: [], step: 1 };
  document.getElementById('wizard-title').textContent = 'Invoice Import — ' + file.name;
  setWizardStep(1); renderWizardStep1();
  openModal('modal-invoice-wizard');
}

function renderWizardStep1() {
  const wc = document.getElementById('wizard-content');
  const wf = document.getElementById('wizard-footer');
  wc.innerHTML = `
    ${DEV_MODE
      ? `<div style="background:rgba(255,217,61,.12);border:1px solid rgba(255,217,61,.4);border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:.82rem;">
          🧪 <strong style="color:var(--warn)">Dev Mode ON</strong> — Sample invoice data will be used.
          <button class="btn btn-ghost btn-sm" style="margin-left:10px" onclick="DEV_MODE=false;renderWizardStep1()">Switch to Live</button>
        </div>`
      : `<div style="background:rgba(78,204,163,.12);border:1px solid rgba(78,204,163,.4);border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:.82rem;">
          🟢 <strong style="color:var(--accent2)">Live Mode</strong> — Real AI extraction (API key required).
          <button class="btn btn-ghost btn-sm" style="margin-left:10px" onclick="DEV_MODE=true;renderWizardStep1()">Switch to Dev</button>
        </div>`
    }
    <p style="font-size:.83rem;color:var(--muted);margin-bottom:14px">Select the supplier for this invoice.</p>
    <div class="form-row c2">
      <div><label>Supplier *</label>
        <select id="wizard-sup-sel"><option value="">— Select —</option>${db.suppliers.map(s=>`<option value="${s.id}">${s.name}</option>`).join('')}</select>
      </div>
      <div style="display:flex;align-items:flex-end">
        <button class="btn btn-ghost btn-sm" onclick="closeModal('modal-invoice-wizard');openSupModal()">+ New Supplier</button>
      </div>
    </div>`;
  wf.innerHTML = `<button class="btn btn-ghost" onclick="closeModal('modal-invoice-wizard')">Cancel</button>
    <button class="btn btn-primary" onclick="wizardExtract()">Next: ${DEV_MODE ? '🧪 Use Dev Data' : 'Extract with AI'} →</button>`;
}

async function wizardExtract() {
  const supId = document.getElementById('wizard-sup-sel').value;
  if (!supId) { toast('Select a supplier first.', 'error'); return; }
  wiz.supplierId = supId;
  setWizardStep(2);
  const wc = document.getElementById('wizard-content');
  const wf = document.getElementById('wizard-footer');

  if (DEV_MODE) {
    wc.innerHTML = `<div class="ai-box ai-thinking">🧪 Dev Mode — Loading sample invoice data…</div>`;
    wf.innerHTML = '';
    await new Promise(r => setTimeout(r, 800));
    wiz.extracted = JSON.parse(JSON.stringify(DEV_INVOICE_DATA));
    wiz.matched   = wiz.extracted.map(row => ({ ...row, userIngredientId: null }));
    setWizardStep(3); renderWizardStep3();
    return;
  }

  wc.innerHTML = `<div class="ai-box ai-thinking" id="wiz-status">🤖 Step 1/2 — Reading invoice and extracting line items…</div>`;
  wf.innerHTML = '';
  try {
    const b64    = await toB64(wiz.file);
    const isText = wiz.file.name.endsWith('.csv');
    let uc;
    if (isText) {
      const txt = atob(b64);
      uc = [{ type: 'text', text: invoiceExtractPrompt(txt) }];
    } else {
      uc = [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
        { type: 'text', text: invoiceExtractPrompt(null) }
      ];
    }
    const res = await claudePost({ model: 'claude-sonnet-4-20250514', max_tokens: 2000,
      messages: [{ role: 'user', content: uc }] });
    const d   = await res.json();
    const txt = d.content?.map(x => x.text||'').join('').replace(/```json|```/g, '').trim();
    wiz.extracted = JSON.parse(txt);
    document.getElementById('wiz-status').textContent =
      `✓ Extracted ${wiz.extracted.length} items. Step 2/2 — Matching to ingredient library…`;
    await wizardMatch();
  } catch(e) {
    wc.innerHTML = `<div class="ai-box ai-error">❌ Extraction error: ${e.message}</div>`;
    wf.innerHTML = `<button class="btn btn-ghost" onclick="closeModal('modal-invoice-wizard')">Close</button>`;
  }
}

async function wizardMatch() {
  const wc = document.getElementById('wizard-content');
  const wf = document.getElementById('wizard-footer');
  try {
    let suggestions = [];
    if (db.ingredients.length > 0) {
      const ingList     = db.ingredients.map(i => ({ id: i.id, name: i.name }));
      const matchPrompt = `Match each invoice item to the best ingredient in the library. Return ONLY a JSON array:
[{"invoiceIndex":0,"suggestedIngredientId":"id_or_null"}]
Set suggestedIngredientId to null if no reasonable match.
Invoice items:\n${wiz.extracted.map((r,i) => `${i}. "${r.name}"`).join('\n')}
Library:\n${ingList.map(i => `id:"${i.id}" name:"${i.name}"`).join('\n')}`;
      const res = await claudePost({ model: 'claude-sonnet-4-20250514', max_tokens: 800,
        messages: [{ role: 'user', content: matchPrompt }] });
      const d   = await res.json();
      const txt = d.content?.map(x => x.text||'').join('').replace(/```json|```/g, '').trim();
      suggestions = JSON.parse(txt);
    }
    wiz.matched = wiz.extracted.map((row, i) => {
      const s = suggestions.find(x => x.invoiceIndex === i) || { suggestedIngredientId: null };
      return { ...row, userIngredientId: s.suggestedIngredientId || null };
    });
    setWizardStep(3); renderWizardStep3();
  } catch(e) {
    wc.innerHTML = `<div class="ai-box ai-error">❌ Matching error: ${e.message}.
      <button class="btn btn-ghost btn-sm" onclick="wiz.matched=wiz.extracted.map(r=>({...r,userIngredientId:null}));setWizardStep(3);renderWizardStep3()">Continue without matching</button></div>`;
    wf.innerHTML = '';
  }
}

function renderWizardStep3() {
  const wc = document.getElementById('wizard-content');
  const wf = document.getElementById('wizard-footer');
  const ingOpts = '<option value="">— Flag as new (skip) —</option>' +
    db.ingredients.map(i => `<option value="${i.id}">${i.name} (${i.recipeUnit})</option>`).join('');

  wc.innerHTML = `
    ${DEV_MODE ? `<div style="background:rgba(255,217,61,.12);border:1px solid rgba(255,217,61,.4);border-radius:6px;padding:8px 12px;margin-bottom:10px;font-size:.78rem;color:var(--warn)">🧪 Dev Mode — sample data shown.</div>` : ''}
    <p style="font-size:.82rem;color:var(--muted);margin-bottom:12px">
      Review each item, confirm the ingredient match, then verify the UOM breakdown.
      <span style="color:var(--warn)">Items with no match will be skipped.</span></p>
    <div id="match-items-list"></div>`;
  wf.innerHTML = `<button class="btn btn-ghost" onclick="closeModal('modal-invoice-wizard')">Cancel</button>
    <button class="btn btn-primary" onclick="renderWizardStep4()">Next: Confirm →</button>`;

  const container = document.getElementById('match-items-list');
  container.innerHTML = wiz.matched.map((r, i) => {
    const matched = !!r.userIngredientId;
    const cpu     = calcCPU(r.total_price, r.buy_qty, r.pack_count, r.pack_size, r.pack_unit||'g', r.buy_unit||'each');
    const cpuStr  = cpu != null
      ? `$${cpu.toFixed(5)} / ${db.ingredients.find(x => x.id === r.userIngredientId)?.recipeUnit || r.recipe_unit || 'unit'}`
      : '— (check pack details)';
    return `<div class="match-item ${matched?'matched':'flagged'}" id="mitem-${i}">
      <div class="match-header">
        <div>
          <div style="font-weight:600;font-size:.88rem">${r.name}</div>
          ${r.notes ? `<div class="muted">${r.notes}</div>` : ''}
        </div>
        <div><label>Match to ingredient</label><select onchange="setMatchIng(${i},this.value)">${ingOpts}</select></div>
        <div style="text-align:right"><div id="mcpu-${i}" class="cpu-display">${cpuStr}</div></div>
      </div>
      <div class="match-uom">
        <div><label>Buy Unit</label>
          <select id="mbu-${i}" onchange="updateMatchCPU(${i})">
            ${BUY_UNITS.map(u => `<option${(r.buy_unit||'each')===u?' selected':''}>${u}</option>`).join('')}
          </select>
        </div>
        <div><label>Qty</label><input id="mbq-${i}" type="number" step="0.01" value="${r.buy_qty||1}" oninput="updateMatchCPU(${i})"></div>
        <div><label>Total Price ($)</label><input id="mtp-${i}" type="number" step="0.01" value="${r.total_price||''}" oninput="updateMatchCPU(${i})"></div>
        <div><label>Pack Count</label><input id="mpc-${i}" type="number" placeholder="e.g. 6" value="${r.pack_count||''}" oninput="updateMatchCPU(${i})"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px">
          <div><label>Pack Size</label><input id="mps-${i}" type="number" step="0.001" placeholder="e.g. 800" value="${r.pack_size||''}" oninput="updateMatchCPU(${i})"></div>
          <div><label>Pack Unit</label>
            <select id="mpu-${i}" onchange="updateMatchCPU(${i})">
              ${PACK_UNITS.map(u => `<option${(r.pack_unit||'g')===u?' selected':''}>${u}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  wiz.matched.forEach((r, i) => {
    const sel = document.getElementById('mitem-'+i)?.querySelector('select');
    if (sel && r.userIngredientId) sel.value = r.userIngredientId;
  });
}

function setMatchIng(i, val) {
  wiz.matched[i].userIngredientId = val || null;
  const item = document.getElementById('mitem-'+i);
  if (item) item.className = 'match-item ' + (val ? 'matched' : 'flagged');
  updateMatchCPU(i);
}

function updateMatchCPU(i) {
  const r = wiz.matched[i];
  r.buy_unit    = document.getElementById('mbu-'+i)?.value || r.buy_unit;
  r.buy_qty     = parseFloat(document.getElementById('mbq-'+i)?.value) || r.buy_qty || 1;
  r.total_price = parseFloat(document.getElementById('mtp-'+i)?.value) || r.total_price || 0;
  r.pack_count  = parseFloat(document.getElementById('mpc-'+i)?.value) || null;
  r.pack_size   = parseFloat(document.getElementById('mps-'+i)?.value) || null;
  r.pack_unit   = document.getElementById('mpu-'+i)?.value || r.pack_unit || 'g';

  const cpu = calcCPU(r.total_price, r.buy_qty, r.pack_count, r.pack_size, r.pack_unit, r.buy_unit);
  const ing = db.ingredients.find(x => x.id === r.userIngredientId);
  const ru  = ing?.recipeUnit || r.recipe_unit || 'unit';
  const el  = document.getElementById('mcpu-'+i);
  if (el) {
    if (cpu != null && r.total_price > 0) {
      el.innerHTML = `<strong style="color:var(--accent2)">$${cpu.toFixed(5)} / ${ru}</strong>`;
      el.style.background = 'rgba(78,204,163,.08)';
    } else {
      el.innerHTML = `<span style="color:var(--warn)">Enter price & pack details</span>`;
      el.style.background = 'rgba(255,217,61,.06)';
    }
  }
}

function renderWizardStep4() {
  wiz.matched.forEach((_, i) => updateMatchCPU(i));
  setWizardStep(4);
  const wc = document.getElementById('wizard-content');
  const wf = document.getElementById('wizard-footer');
  const matched = wiz.matched.filter(r => r.userIngredientId);
  const skipped = wiz.matched.filter(r => !r.userIngredientId);
  let totalVal = 0; matched.forEach(r => totalVal += parseFloat(r.total_price)||0);

  wc.innerHTML = `
    ${DEV_MODE ? `<div style="background:rgba(255,217,61,.12);border:1px solid rgba(255,217,61,.4);border-radius:6px;padding:8px 12px;margin-bottom:10px;font-size:.78rem;color:var(--warn)">🧪 Dev Mode — sample data only.</div>` : ''}
    <div class="cb" style="margin-bottom:12px">
      <strong style="color:var(--accent2)">${matched.length}</strong> items will update WAC &nbsp;|&nbsp;
      <strong style="color:var(--warn)">${skipped.length}</strong> skipped &nbsp;|&nbsp;
      Total: <strong style="color:var(--accent2)">$${fmt(totalVal)}</strong>
    </div>
    <div style="overflow-x:auto"><table style="font-size:.8rem;width:100%">
      <thead><tr><th>Invoice Item</th><th>→ Ingredient</th><th>Pack Details</th><th>Total $</th><th>New WAC</th></tr></thead>
      <tbody>
      ${matched.map(r => {
        const ing  = db.ingredients.find(x => x.id === r.userIngredientId);
        const cpu  = calcCPU(r.total_price, r.buy_qty, r.pack_count, r.pack_size, r.pack_unit, r.buy_unit);
        const bu   = getBaseUnits(r.buy_qty, r.pack_count, r.pack_size, r.pack_unit, r.buy_unit);
        const au   = ing?.totalBaseUnits || 0;
        const av   = (ing?.wac||0) * au;
        const nWAC = cpu && (au+bu) > 0 ? ((av+(parseFloat(r.total_price)||0))/(au+bu)) : cpu;
        const pd   = r.pack_count && r.pack_size ? `${r.buy_qty}×${r.pack_count}×${r.pack_size}${r.pack_unit}` : `${r.buy_qty} ${r.buy_unit}`;
        return `<tr>
          <td>${r.name}</td><td><strong>${ing?.name||'?'}</strong></td>
          <td style="color:var(--muted)">${pd}</td><td>$${fmt(r.total_price)}</td>
          <td style="color:var(--warn)">${nWAC != null ? `$${nWAC.toFixed(5)}/${ing?.recipeUnit||'g'}` : '—'}</td>
        </tr>`;
      }).join('')}
      ${skipped.map(r => `<tr style="opacity:.4"><td>${r.name}</td><td colspan="4" style="color:var(--warn)">⚠ Skipped</td></tr>`).join('')}
      </tbody></table></div>`;
  wf.innerHTML = `<button class="btn btn-ghost" onclick="setWizardStep(3);renderWizardStep3()">← Back</button>
    <button class="btn btn-ghost" onclick="closeModal('modal-invoice-wizard')">Cancel</button>
    <button class="btn btn-success" onclick="approveInvoiceImport()">✓ Approve & Update WAC</button>`;
}

function approveInvoiceImport() {
  const sup     = db.suppliers.find(s => s.id === wiz.supplierId);
  const matched = wiz.matched.filter(r => r.userIngredientId);
  let totalVal  = 0;
  matched.forEach(r => {
    const ing = db.ingredients.find(x => x.id === r.userIngredientId); if (!ing) return;
    const cpu = calcCPU(r.total_price, r.buy_qty, r.pack_count, r.pack_size, r.pack_unit, r.buy_unit);
    if (!cpu) return;
    const baseUnits = getBaseUnits(r.buy_qty, r.pack_count, r.pack_size, r.pack_unit, r.buy_unit);
    const price = parseFloat(r.total_price)||0; totalVal += price;
    if (!ing.purchases) ing.purchases = [];
    ing.purchases.push({ id: uid(), date: wiz.invoiceDate || todayStr(), supplierId: wiz.supplierId,
      invoiceNo: wiz.file.name || null,
      buyUnit: r.buy_unit, buyQty: r.buy_qty, packCount: r.pack_count||null,
      packSize: r.pack_size||null, packUnit: r.pack_unit||'g',
      totalPrice: price, cpru: cpu, baseUnits, obsolete: false });
    recalcWAC(ing);
  });
  const skippedNames = wiz.matched.filter(r => !r.userIngredientId).map(r => r.name);
  db.importLog.push({ id: uid(), date: wiz.invoiceDate || todayStr(), filename: wiz.file.name, invoiceNo: wiz.file.name, type: 'invoice',
    supplierId: wiz.supplierId, supplierName: sup?.name||'',
    itemCount: wiz.extracted.length, matchedCount: matched.length,
    skippedItems: skippedNames, totalValue: totalVal, status: 'approved',
    data: JSON.parse(JSON.stringify(wiz.matched)) });
  saveDB(); closeModal('modal-invoice-wizard'); renderIngredients(); renderImportLog(); renderCSVQueue();
  toast(`Invoice imported: ${matched.length} WAC updated${skippedNames.length ? ' | '+skippedNames.length+' skipped' : ''}.`);

  // If this invoice came from the Gmail queue, mark it as imported
  if (wiz.emailQueueId) {
    const url = localStorage.getItem('rcc-gmail-webapp-url');
    if (url) {
      fetch(url, { method: 'POST', body: JSON.stringify({ id: wiz.emailQueueId, action: 'imported' }) })
        .then(() => pollEmailQueue())
        .catch(() => {});
    }
  }
}

// ── MODIFIER LIBRARY ─────────────────────────────────────────────────────────
// Persistent management table for modifier → ingredient links.
// Same db.modifierLinks used by import review + calcTheoreticalUsage.

const MOD_UNITS = ['g','kg','ml','L','each','portion'];

function renderModifierLinks() {
  const tbody = document.getElementById('modifier-links-body');
  if (!tbody) return;
  if (!db.modifierLinks) db.modifierLinks = [];

  if (!db.modifierLinks.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:20px;font-size:.82rem">
      No modifier links yet. They are created automatically when you import Square sales, or add one manually.
    </td></tr>`;
    return;
  }

  tbody.innerHTML = db.modifierLinks.map((ml, idx) => {
    const type = ml.type || modifierType(ml.pattern || '');
    const ingOpts = '<option value="">— no link —</option>' +
      db.ingredients.map(i =>
        `<option value="${i.id}"${ml.ingredientId === i.id ? ' selected' : ''}>${i.name} (${i.recipeUnit})</option>`
      ).join('');
    const unitOpts = MOD_UNITS.map(u => `<option${(ml.unit || 'g') === u ? ' selected' : ''}>${u}</option>`).join('');
    const safePattern = (ml.pattern || '').replace(/"/g, '&quot;');

    // Cost cell: auto-computed from WAC when ingredient is linked, else manual entry
    let costCell;
    if (ml.ingredientId && ml.qty) {
      const ing = db.ingredients.find(i => i.id === ml.ingredientId);
      const autoCost = ing ? effectiveCost(ing) * (ml.qty || 0) : 0;
      costCell = `<td style="font-size:.8rem">
        <span style="color:var(--accent2);font-weight:600">$${fmt(autoCost)}</span>
        <div style="font-size:.7rem;color:var(--muted)">auto</div>
      </td>`;
    } else {
      costCell = `<td><input type="number" step="0.01" min="0" placeholder="0.00"
        value="${ml.extraCost || ''}" style="width:65px;font-size:.8rem"
        oninput="updateModifierLinkByIdx(${idx},'extraCost',this.value)"></td>`;
    }

    return `<tr>
      <td><span class="badge ${type === 'add' ? 'bg' : type === 'remove' ? 'br' : 'bw'}">${type === 'add' ? '+ ADD' : type === 'remove' ? '− REM' : 'neutral'}</span></td>
      <td><input value="${safePattern}" style="font-size:.8rem;min-width:180px"
        onchange="updateModifierLinkByIdx(${idx},'pattern',this.value)"></td>
      <td><select style="font-size:.76rem;min-width:160px"
        onchange="updateModifierLinkByIdx(${idx},'ingredientId',this.value)">${ingOpts}</select></td>
      <td><input type="number" step="0.01" min="0" placeholder="0" value="${ml.qty || ''}"
        style="width:60px;font-size:.8rem"
        oninput="updateModifierLinkByIdx(${idx},'qty',this.value)"></td>
      <td><select style="font-size:.76rem;width:58px"
        onchange="updateModifierLinkByIdx(${idx},'unit',this.value)">${unitOpts}</select></td>
      ${costCell}
      <td><button class="btn btn-danger btn-sm" onclick="deleteModifierLink(${idx})">✕</button></td>
    </tr>`;
  }).join('');
}

function updateModifierLinkByIdx(idx, field, val) {
  if (!db.modifierLinks || !db.modifierLinks[idx]) return;
  const ml = db.modifierLinks[idx];
  if (field === 'qty' || field === 'extraCost') {
    ml[field] = parseFloat(val) || 0;
  } else {
    ml[field] = val;
  }
  // Re-derive type when pattern changes; refresh cost display when ingredient/qty changes
  if (field === 'pattern') {
    ml.type = modifierType(val);
    renderModifierLinks();
  } else if (field === 'ingredientId' || field === 'qty') {
    renderModifierLinks(); // refresh auto-cost display
  }
  saveDB();
}

function deleteModifierLink(idx) {
  if (!confirm('Remove this modifier link?')) return;
  db.modifierLinks.splice(idx, 1);
  saveDB();
  renderModifierLinks();
}

function addModifierLink() {
  if (!db.modifierLinks) db.modifierLinks = [];
  db.modifierLinks.push({ pattern: '', type: 'neutral', ingredientId: null, qty: 0, unit: 'g', extraCost: 0 });
  saveDB();
  renderModifierLinks();
}

// ── IMPORT LOG ───────────────────────────────────────────────────────────────
function renderImportLog() {
  const tb = document.getElementById('import-log-table');
  if (!db.importLog.length) {
    tb.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:28px">No imports yet.</td></tr>'; return;
  }
  tb.innerHTML = [...db.importLog].sort((a,b) => b.date.localeCompare(a.date)).map(l => `<tr>
    <td>${l.date}</td><td>${l.supplierName||'—'}</td>
    <td style="font-size:.78rem">${l.filename}</td>
    <td><span class="badge ${l.type==='invoice'?'bp':'bg'}">${l.type==='invoice'?'Invoice':'Sales'}</span></td>
    <td>${l.matchedCount??l.itemCount}/${l.itemCount}${l.linkedCount != null ? `<div class="muted">${l.linkedCount} with recipe</div>` : ''}</td>
    <td>$${fmt(l.totalValue)}</td>
    <td><span class="badge bg">✓ ${l.status}</span>${l.skippedItems?.length ? `<div class="muted">${l.skippedItems.length} skipped</div>` : ''}</td>
    <td><button class="btn btn-ghost btn-sm" onclick="reOpenImport('${l.id}')">Re-review</button></td>
  </tr>`).join('');
}

function reOpenImport(id) {
  const log = db.importLog.find(x => x.id === id); if (!log) return;
  if (log.type === 'sales') {
    pendingSalesImport = { file: { name: log.filename }, data: JSON.parse(JSON.stringify(log.data)), isSquare: true };
    document.getElementById('sales-ai-status').style.display = 'none';
    document.getElementById('sales-ai-content').innerHTML = '';
    renderSquareSalesReview(pendingSalesImport.data);
    document.getElementById('sales-ai-approve').style.display = 'inline-block';
    openModal('modal-sales-ai');
  } else {
    wiz = { file: { name: log.filename }, supplierId: log.supplierId||'',
      extracted: log.data, matched: JSON.parse(JSON.stringify(log.data)), step: 3 };
    document.getElementById('wizard-title').textContent = 'Re-review: ' + log.filename;
    setWizardStep(3); renderWizardStep3(); openModal('modal-invoice-wizard');
  }
}

// ── AI PROMPTS ───────────────────────────────────────────────────────────────
function invoiceExtractPrompt(text) {
  const sup = db.suppliers.find(s => s.id === wiz.supplierId);
  if (sup && sup.name.toLowerCase().includes('bidfood')) return invoiceExtractPromptBidfood(text);
  return `Extract all product/ingredient line items from this supplier invoice. Return ONLY a valid JSON array, no markdown.
Each object: name(string), buy_unit(string: carton/case/bag/box/each/dozen/kg/L/lb/g/ml), buy_qty(number), total_price(number for this line), pack_count(number or null), pack_size(number or null), pack_unit(string: g/ml/kg/L), recipe_unit(string: g/ml/each), notes(string or "").
Examples:
"1 carton 6×800g cans @ $36" → {buy_unit:"carton",buy_qty:1,total_price:36,pack_count:6,pack_size:800,pack_unit:"g",recipe_unit:"g"}
"5kg flour $12" → {buy_unit:"kg",buy_qty:5,total_price:12,pack_count:null,pack_size:null,pack_unit:"g",recipe_unit:"g"}
${text ? 'FILE:\n' + text.slice(0, 5000) : ''}`;
}

function invoiceExtractPromptBidfood(text) {
  return `You are extracting line items from a Bidfood (Malaga, WA) supplier invoice into a structured format for a restaurant ingredient WAC (Weighted Average Cost) system.

For each line item, extract these fields:
- Buy Unit
- Qty
- Total Price ($)
- Pack Count
- Pack Size
- Pack Unit

---

RULES FOR EACH FIELD:

**Buy Unit:**
Determine based on what was actually received — do NOT default to "carton":
- Use "carton" only when a full sealed carton was purchased (i.e. Cartons Supplied column is filled AND CTN count > 1, meaning multiple packs are inside e.g. CTN=5, CTN=2)
- Use "each" when individual loose units were purchased (i.e. Units Supplied column is filled, meaning single packs pulled from a carton e.g. 1x720g, 2x1kg)
- Use "drum" for drum containers (e.g. oil in DRUM=1)
- Use "each" for any other individual unit not fitting above

**Qty:**
- If Buy Unit = "carton": Qty = number in Cartons Supplied column
- If Buy Unit = "each": Qty = number in Units Supplied column
- If Buy Unit = "drum": Qty = number in Units Supplied column
- Qty always refers to how many Buy Units were purchased

**Total Price ($):**
- Use the "Total Value" column for that line item exactly as printed
- Do NOT calculate — read directly from invoice

**Pack Count:**
- If Buy Unit = "carton": Pack Count = the CTN= number (e.g. CTN=5 → Pack Count=5, CTN=2 → Pack Count=2)
- If Buy Unit = "each" or "drum": Pack Count = 1 (you are buying a single pack/unit)

**Pack Size:**
- Extract the numeric size of each individual pack
- Examples: "1kg" → 1, "720gr" → 720, "20lt" → 20, "5kg" → 5, "500gr" → 500, "3.03kg" → 3.03, "350gr" → 350, "2kg" → 2
- For multi-pack formats like "6x2kg": Pack Size = 2 (the individual pack size, Pack Count handles the quantity)

**Pack Unit:**
- Extract the unit of measure for Pack Size
- "gr" or "g" on invoice → use "g"
- "lt" on invoice → use "lt"
- "kg" on invoice → use "kg"

---

REFERENCE EXAMPLES (verified correct extractions from past invoices):

| Product | Buy Unit | Qty | Total Price ($) | Pack Count | Pack Size | Pack Unit |
|---|---|---|---|---|---|---|
| CHICKEN NUGGETS BREAST CRUMBED INGHAM 1kg | carton | 1 | 72.45 | 5 | 1 | kg |
| ANCHOVIES SANDHURST 720gr | each | 1 | 16.99 | 1 | 720 | g |
| CHEESE MASCARPONE TATUA 1kg | each | 2 | 35.26 | 1 | 1 | kg |
| CHEESE PARMESAN GRATED BLEND DAIRY FARM 1kg | each | 1 | 18.66 | 1 | 1 | kg |
| CHEESE PARMESAN SHAVED ALFINAS 1kg | each | 1 | 23.02 | 1 | 1 | kg |
| OIL VEGETABLE SELESTA 20lt | drum | 1 | 66.47 | 1 | 20 | lt |
| PASTA SPAGHETTI NO 5 SAN REMO 5kg | carton | 1 | 27.06 | 2 | 5 | kg |
| PEPPER BLACK CRACKED CULPEPERS 1kg | each | 1 | 34.27 | 1 | 1 | kg |
| CHIPS 9MM SKIN ON SURE CRISP FRIES MCCAIN 6x2kg | carton | 1 | 69.00 | 6 | 2 | kg |
| MARINARA SEAFOOD MIX SEAFROST 1kg | each | 3 | 47.40 | 1 | 1 | kg |
| PASTA PENNE GLUTEN FREE SAN REMO 10x350gr | carton | 1 | 37.70 | 10 | 350 | g |
| PINEAPPLE PIZZA CUT IN LIGHT SYRUP DEWFRESH 3.03kg | carton | 1 | 80.88 | 6 | 3.03 | kg |
| SUGAR WHITE BUNDABERG 2kg | each | 1 | 5.95 | 1 | 2 | kg |
| TOMATO PASTE LEGGOS 500gr | carton | 1 | 33.84 | 6 | 500 | g |

---

IMPORTANT REMINDERS:
- Never assume Buy Unit is always "carton"
- Always check BOTH the Cartons Supplied AND Units Supplied columns
- Total Price is read directly from invoice, never calculated
- Skip summary rows, carton count rows, and GST rows
- Only extract actual product line items

Return ONLY a valid JSON array, no markdown. Each object must have: name(string), buy_unit(string), buy_qty(number), total_price(number), pack_count(number or null), pack_size(number or null), pack_unit(string), recipe_unit(string: g/ml/each), notes(string or "").

${text ? 'INVOICE:\n' + text.slice(0, 6000) : ''}`;
}

function toB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result.split(',')[1]);
    r.onerror = () => rej(new Error('Read failed'));
    r.readAsDataURL(file);
  });
}