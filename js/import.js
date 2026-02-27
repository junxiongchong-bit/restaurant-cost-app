// ── DEV MODE ────────────────────────────────────────────────────────────────
// Set to true during development to skip real API calls (saves cost!)
// Set to false when ready to go live with real invoice scanning
let DEV_MODE = true;

const DEV_INVOICE_DATA = [
  { name: "Chicken Breast", buy_unit: "kg", buy_qty: 5, total_price: 32.50, pack_count: null, pack_size: null, pack_unit: "g", recipe_unit: "g", notes: "" },
  { name: "Beef Mince", buy_unit: "kg", buy_qty: 3, total_price: 24.00, pack_count: null, pack_size: null, pack_unit: "g", recipe_unit: "g", notes: "" },
  { name: "Tomato Paste", buy_unit: "carton", buy_qty: 1, total_price: 18.00, pack_count: 6, pack_size: 800, pack_unit: "g", recipe_unit: "g", notes: "6x800g cans" },
  { name: "Olive Oil", buy_unit: "each", buy_qty: 2, total_price: 22.00, pack_count: null, pack_size: null, pack_unit: "ml", recipe_unit: "ml", notes: "2L bottle" },
  { name: "Plain Flour", buy_unit: "kg", buy_qty: 10, total_price: 14.00, pack_count: null, pack_size: null, pack_unit: "g", recipe_unit: "g", notes: "" }
];

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
    throw new Error('API key required — enter it in the Settings panel that just opened, then try again.');
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

// ── SQUARE CSV PARSER ────────────────────────────────────────────────────────
// Parses Square item-level CSV export directly — no AI needed, zero cost!
function parseSquareCSV(csvText) {
  const lines = csvText.trim().split('\n');
  const headers = parseCSVLine(lines[0]);
  const commission = getDeliveryCommission();
  const deliveryChannel = getDeliveryChannel().toLowerCase();
  const itemMap = {};

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 5) continue;

    const row = {};
    headers.forEach((h, idx) => row[h.trim()] = (cols[idx] || '').trim());

    const item    = row['Item'] || '';
    const channel = row['Channel'] || '';
    const qty     = parseFloat(row['Qty']) || 0;
    const net     = parseMoney(row['Net Sales']); // already after discounts, this is our base

    // Skip delivery notes, order IDs, blank items, zero/negative/comped items
    if (!item || item.startsWith('Order ID') || item.startsWith('DELIVERY') || net <= 0 || qty <= 0) continue;

    // Determine channel type
    const isDelivery = channel.toLowerCase().includes(deliveryChannel);
    const channelType = isDelivery ? 'delivery' : 'dinein';

    // Commission is taken from Net Sales for delivery orders
    const commissionLost = isDelivery ? net * commission : 0;
    const trueNet        = isDelivery ? net * (1 - commission) : net;

    const key = `${item}|||${channelType}`;
    if (!itemMap[key]) {
      itemMap[key] = {
        name: item,
        channel: channelType,
        channelLabel: isDelivery ? 'Delivery' : 'Dine-in',
        qty: 0,
        grossRevenue: 0,  // Net Sales (after discount, before commission)
        trueRevenue: 0,   // after commission for delivery
        commissionLost: 0
      };
    }
    itemMap[key].qty            += qty;
    itemMap[key].grossRevenue   += net;
    itemMap[key].trueRevenue    += trueNet;
    itemMap[key].commissionLost += commissionLost;
  }

  return Object.values(itemMap);
}

// Robust CSV parser — handles quoted fields with commas inside
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseMoney(str) {
  return parseFloat((str || '0').replace(/[$,]/g, '')) || 0;
}

// ── SQUARE SALES IMPORT ──────────────────────────────────────────────────────
async function startSalesImport(input) {
  const file = input.files[0]; if (!file) return; input.value = '';

  const dup = db.importLog.find(l => l.filename === file.name && l.type === 'sales');
  if (dup && !confirm(`"${file.name}" already imported on ${dup.date}. Continue?`)) return;

  const commission = getDeliveryCommission();
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

    // Detect Square CSV by checking headers
    const firstLine = text.split('\n')[0];
    const isSquareCSV = firstLine.includes('Net Sales') && firstLine.includes('Channel') && firstLine.includes('Gross Sales');

    if (!isSquareCSV) {
      throw new Error('This does not look like a Square items CSV. Please export the "Items" report from Square Dashboard → Reports → Sales.');
    }

    const parsed = parseSquareCSV(text);

    if (!parsed.length) {
      throw new Error('No valid sales rows found. Check the file is a Square Items export with actual sales.');
    }

    pendingSalesImport = { file, data: parsed, isSquare: true };
    st.style.display = 'none';
    renderSquareSalesReview(parsed, commission);
    document.getElementById('sales-ai-approve').style.display = 'inline-block';

  } catch(e) {
    st.className   = 'ai-box ai-error';
    st.textContent = '❌ ' + e.message;
  }
}

function renderSquareSalesReview(data, commission) {
  const totalDineIn    = data.filter(r => r.channel === 'dinein').reduce((s, r) => s + r.trueRevenue, 0);
  const totalDelivery  = data.filter(r => r.channel === 'delivery').reduce((s, r) => s + r.trueRevenue, 0);
  const totalCommLost  = data.reduce((s, r) => s + r.commissionLost, 0);

  document.getElementById('sales-ai-content').innerHTML = `
    <div style="background:rgba(78,204,163,.08);border:1px solid rgba(78,204,163,.25);border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:.82rem;">
      📊 <strong style="color:var(--accent2)">Square CSV parsed</strong> — ${data.length} line items. No AI used, no cost.
    </div>

    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
      <div class="stat" style="padding:10px">
        <div class="stat-val" style="font-size:1.1rem;color:var(--accent2)">$${fmt(totalDineIn)}</div>
        <div class="stat-label">Dine-in Net Sales</div>
      </div>
      <div class="stat" style="padding:10px">
        <div class="stat-val" style="font-size:1.1rem;color:var(--accent2)">$${fmt(totalDelivery)}</div>
        <div class="stat-label">Delivery Net (after ${(commission*100).toFixed(0)}% commission)</div>
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

    <div style="overflow-x:auto;max-height:360px;overflow-y:auto">
      <table style="font-size:.8rem">
        <thead>
          <tr>
            <th>Item</th>
            <th>Channel</th>
            <th>Qty</th>
            <th>Net Sales (after discount)</th>
            <th>Commission Lost</th>
            <th>True Net Revenue</th>
          </tr>
        </thead>
        <tbody>
          ${[...data].sort((a,b) => b.trueRevenue - a.trueRevenue).map(r => `<tr>
            <td><strong>${r.name}</strong></td>
            <td><span class="badge ${r.channel === 'dinein' ? 'bg' : 'bp'}">${r.channelLabel}</span></td>
            <td>${r.qty}</td>
            <td>$${fmt(r.grossRevenue)}</td>
            <td style="color:var(--danger)">${r.channel === 'delivery' ? `-$${fmt(r.commissionLost)}` : '—'}</td>
            <td><strong style="color:var(--accent2)">$${fmt(r.trueRevenue)}</strong></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function approveSalesImport() {
  const { data, isSquare } = pendingSalesImport;
  let matched = 0, totalRev = 0;

  if (isSquare) {
    data.forEach(r => {
      if (!r.name || !r.qty) return;
      let m = db.menuItems.find(x => x.name.toLowerCase() === r.name.toLowerCase());
      if (!m) {
        m = { id: uid(), name: r.name, price: r.qty > 0 ? r.trueRevenue / r.qty : 0, recipeId: '', category: r.channelLabel };
        db.menuItems.push(m);
      }
      const rev  = r.trueRevenue;
      totalRev  += rev;
      const rec  = db.recipes.find(x => x.id === m.recipeId);
      const snap = rec ? calcRecipeCost(rec.lines, true) : 0;
      db.sales.push({
        id: uid(), date: todayStr(), itemId: m.id, qty: r.qty,
        revenue: rev, snapshotCost: snap,
        channel: r.channel, channelLabel: r.channelLabel,
        grossRevenue: r.grossRevenue, commissionLost: r.commissionLost
      });
      matched++;
    });
  } else {
    // Legacy fallback
    data.forEach(r => {
      if (!r.name || !r.qty_sold) return;
      let m = db.menuItems.find(x => x.name.toLowerCase() === r.name.toLowerCase());
      if (!m) { m = { id: uid(), name: r.name, price: r.selling_price||0, recipeId: '', category: 'Imported' }; db.menuItems.push(m); }
      const rev = (r.selling_price||0) * r.qty_sold; totalRev += rev;
      const rec  = db.recipes.find(x => x.id === m.recipeId);
      const snap = rec ? calcRecipeCost(rec.lines, true) : 0;
      db.sales.push({ id: uid(), date: todayStr(), itemId: m.id, qty: r.qty_sold, revenue: rev, snapshotCost: snap, channel: 'dinein', channelLabel: 'Dine-in' });
      matched++;
    });
  }

  db.importLog.push({
    id: uid(), date: todayStr(), filename: pendingSalesImport.file.name, type: 'sales',
    supplierName: 'Square', itemCount: data.length, matchedCount: matched,
    totalValue: totalRev, status: 'approved', data: JSON.parse(JSON.stringify(data))
  });

  saveDB(); closeModal('modal-sales-ai'); renderSales(); renderImportLog();
  toast(`Square import: ${matched} items imported. True revenue: $${fmt(totalRev)}`);
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
          🧪 <strong style="color:var(--warn)">Dev Mode ON</strong> — Sample invoice data will be used. No API calls, no cost.
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
    ing.purchases.push({ id: uid(), date: todayStr(), supplierId: wiz.supplierId,
      buyUnit: r.buy_unit, buyQty: r.buy_qty, packCount: r.pack_count||null,
      packSize: r.pack_size||null, packUnit: r.pack_unit||'g',
      totalPrice: price, cpru: cpu, baseUnits, obsolete: false });
    recalcWAC(ing);
  });
  const skippedNames = wiz.matched.filter(r => !r.userIngredientId).map(r => r.name);
  db.importLog.push({ id: uid(), date: todayStr(), filename: wiz.file.name, type: 'invoice',
    supplierId: wiz.supplierId, supplierName: sup?.name||'',
    itemCount: wiz.extracted.length, matchedCount: matched.length,
    skippedItems: skippedNames, totalValue: totalVal, status: 'approved',
    data: JSON.parse(JSON.stringify(wiz.matched)) });
  saveDB(); closeModal('modal-invoice-wizard'); renderIngredients(); renderImportLog();
  toast(`Invoice imported: ${matched.length} WAC updated${skippedNames.length ? ' | '+skippedNames.length+' skipped' : ''}.`);
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
    <td>${l.matchedCount??l.itemCount}/${l.itemCount}</td>
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
    renderSquareSalesReview(pendingSalesImport.data, getDeliveryCommission());
    document.getElementById('sales-ai-approve').style.display = 'inline-block';
    openModal('modal-sales-ai');
  } else {
    wiz = { file: { name: log.filename }, supplierId: log.supplierId||'',
      extracted: log.data, matched: JSON.parse(JSON.stringify(log.data)), step: 3 };
    document.getElementById('wizard-title').textContent = 'Re-review: ' + log.filename;
    setWizardStep(3); renderWizardStep3(); openModal('modal-invoice-wizard');
  }
}

// ── AI PROMPTS (invoice scanning only) ───────────────────────────────────────
function invoiceExtractPrompt(text) {
  return `Extract all product/ingredient line items from this supplier invoice. Return ONLY a valid JSON array, no markdown.
Each object: name(string), buy_unit(string: carton/case/bag/box/each/dozen/kg/L/lb/g/ml), buy_qty(number), total_price(number for this line), pack_count(number or null), pack_size(number or null), pack_unit(string: g/ml/kg/L), recipe_unit(string: g/ml/each), notes(string or "").
Examples:
"1 carton 6×800g cans @ $36" → {buy_unit:"carton",buy_qty:1,total_price:36,pack_count:6,pack_size:800,pack_unit:"g",recipe_unit:"g"}
"5kg flour $12" → {buy_unit:"kg",buy_qty:5,total_price:12,pack_count:null,pack_size:null,pack_unit:"g",recipe_unit:"g"}
${text ? 'FILE:\n' + text.slice(0, 5000) : ''}`;
}

function toB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result.split(',')[1]);
    r.onerror = () => rej(new Error('Read failed'));
    r.readAsDataURL(file);
  });
}