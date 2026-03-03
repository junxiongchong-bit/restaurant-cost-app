// ── APP STATE ──────────────────────────────────────────────────────────────
let editId = null, recipeLines = [], detailIngId = null;
let wiz = { file: null, supplierId: '', extracted: [], matched: [], step: 1 };
let pendingSalesImport = null;

// ── NAVIGATION ─────────────────────────────────────────────────────────────
function goPage(id, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById('page-'+id).classList.add('active');
  if(btn) btn.classList.add('active');
  ({
    dashboard:   renderDashboard,
    suppliers:   renderSuppliers,
    ingredients: renderIngredients,
    recipes:     renderRecipes,
    menu:        renderMenu,
    sales:       renderSales,
    reports:     () => renderReports(),
    import:      renderImport,
    inventory:   renderInventory,
    production:  renderProduction
  })[id]?.();
}

function openModal(id)  { document.getElementById(id).classList.add('open'); }

function openSettingsModal() {
  // Pre-fill saved values
  document.getElementById('settings-api-key').value = localStorage.getItem('rcc-api-key') || '';
  document.getElementById('settings-commission').value = localStorage.getItem('rcc-delivery-commission') || '37';
  document.getElementById('settings-channel').value = localStorage.getItem('rcc-delivery-channel') || 'Doshii';
  document.getElementById('set-sq-token').value = localStorage.getItem('rcc-square-token') || '';
  document.getElementById('set-sq-location').value = localStorage.getItem('rcc-square-location') || '';
  document.getElementById('settings-fb-url').value = localStorage.getItem('rcc-fb-db-url') || '';
  document.getElementById('settings-gmail-url').value = localStorage.getItem('rcc-gmail-webapp-url') || '';
  document.getElementById('settings-gmail-whitelist').value = localStorage.getItem('rcc-gmail-whitelist') || '';
  openModal('modal-settings');
}

function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function toast(msg, type='success') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'show ' + type;
  setTimeout(() => t.className = '', 2800);
}

// ── SUPPLIERS ──────────────────────────────────────────────────────────────
function populateSupSel(id, val='') {
  const el = document.getElementById(id); if(!el) return;
  el.innerHTML = '<option value="">— None —</option>' +
    db.suppliers.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  if(val) el.value = val;
}

function openSupModal(id=null) {
  editId = id;
  document.getElementById('sup-modal-title').textContent = id ? 'Edit Supplier' : 'Add Supplier';
  if(id) {
    const s = db.suppliers.find(x => x.id === id);
    ['name','contact','phone','email','notes'].forEach(f => document.getElementById('sup-'+f).value = s[f]||'');
  } else {
    ['sup-name','sup-contact','sup-phone','sup-email','sup-notes'].forEach(x => document.getElementById(x).value = '');
  }
  openModal('modal-sup');
}

function saveSupplier() {
  const name = document.getElementById('sup-name').value.trim();
  if(!name) { toast('Name required.', 'error'); return; }
  const obj = { id: editId||uid(), name,
    contact: document.getElementById('sup-contact').value,
    phone:   document.getElementById('sup-phone').value,
    email:   document.getElementById('sup-email').value,
    notes:   document.getElementById('sup-notes').value };
  if(editId) { const i = db.suppliers.findIndex(x => x.id === editId); db.suppliers[i] = obj; }
  else db.suppliers.push(obj);
  saveDB(); closeModal('modal-sup'); renderSuppliers();
  toast(editId ? 'Updated.' : 'Supplier added.'); editId = null;
}

function exportSuppliersCSV() {
  const rows = [['Name', 'Contact', 'Phone', 'Email', 'Notes']];
  db.suppliers.forEach(s => rows.push([s.name, s.contact||'', s.phone||'', s.email||'', s.notes||'']));
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n'));
  a.download = `suppliers_${todayStr()}.csv`;
  a.click();
}

function deleteSupplier(id) {
  if(!confirm('Delete?')) return;
  db.suppliers = db.suppliers.filter(x => x.id !== id);
  saveDB(); renderSuppliers();
}

function renderSuppliers() {
  const tb = document.getElementById('sup-table');
  const q = (document.getElementById('sup-search')?.value || '').toLowerCase();
  let list = db.suppliers.filter(s => !q || s.name.toLowerCase().includes(q) || (s.contact||'').toLowerCase().includes(q));
  list = sortApply(list, 'sup', (s, col) => col === 'contact' ? s.contact||'' : s.name);
  applyHdrs('sup', { 'th-sup-name': ['name','Name'], 'th-sup-contact': ['contact','Contact'] });
  if(!list.length) {
    tb.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:28px">No suppliers yet.</td></tr>'; return;
  }
  tb.innerHTML = list.map(s => `<tr>
    <td><strong>${s.name}</strong></td><td>${s.contact||'—'}</td><td>${s.phone||'—'}</td><td>${s.email||'—'}</td>
    <td style="color:var(--muted);font-size:.78rem;max-width:180px">${s.notes||'—'}</td>
    <td class="flex">
      <button class="btn btn-ghost btn-sm" onclick="openSupModal('${s.id}')">Edit</button>
      <button class="btn btn-danger btn-sm" onclick="deleteSupplier('${s.id}')">Del</button>
    </td>
  </tr>`).join('');
}

// ── DASHBOARD ──────────────────────────────────────────────────────────────
function renderDashboard() {
  let rev = 0, cost = 0;
  db.sales.forEach(s => { rev += s.revenue; cost += (s.snapshotCost||0) * s.qty; });
  const profit = rev - cost, pct = rev > 0 ? (cost/rev*100) : 0;
  document.getElementById('dash-stats').innerHTML = `
    <div class="stat"><div class="stat-val" style="color:var(--accent2)">$${fmt(rev)}</div><div class="stat-label">Total Revenue</div></div>
    <div class="stat"><div class="stat-val" style="color:var(--danger)">$${fmt(cost)}</div><div class="stat-label">Food Cost (yield-adj)</div></div>
    <div class="stat"><div class="stat-val" style="color:var(--accent2)">$${fmt(profit)}</div><div class="stat-label">Gross Profit</div></div>
    <div class="stat"><div class="stat-val" style="color:${pctCol(pct)}">${fmt(pct,1)}%</div><div class="stat-label">Overall Cost %</div></div>`;
  const byItem = {};
  db.sales.forEach(s => {
    const m = db.menuItems.find(x => x.id === s.itemId); if(!m) return;
    if(!byItem[m.id]) byItem[m.id] = { name: m.name, rev: 0, cost: 0 };
    byItem[m.id].rev  += s.revenue;
    byItem[m.id].cost += (s.snapshotCost||0) * s.qty;
  });
  const items = Object.values(byItem).sort((a,b) => (b.cost/b.rev||0) - (a.cost/a.rev||0));
  document.getElementById('dash-items').innerHTML = items.length
    ? items.slice(0,6).map(i => {
        const p = i.rev > 0 ? (i.cost/i.rev*100) : 0, col = pctCol(p);
        return `<div style="margin-bottom:10px">
          <div class="fb" style="margin-bottom:3px"><span style="font-size:.82rem">${i.name}</span><strong style="color:${col}">${fmt(p,1)}%</strong></div>
          <div class="pbar"><div class="pfill" style="width:${Math.min(p,100)}%;background:${col}"></div></div>
        </div>`;
      }).join('')
    : '<div class="muted" style="padding:16px 0">No sales yet.</div>';
  document.getElementById('dash-overview').innerHTML = `<div style="font-size:.83rem;display:grid;gap:8px">
    <div class="fb"><span class="muted">Suppliers</span><strong>${db.suppliers.length}</strong></div>
    <div class="fb"><span class="muted">Ingredients</span><strong>${db.ingredients.length}</strong></div>
    <div class="fb"><span class="muted">Recipes</span><strong>${db.recipes.length}</strong></div>
    <div class="fb"><span class="muted">Menu Items</span><strong>${db.menuItems.length}</strong></div>
    <div class="fb"><span class="muted">Sales Records</span><strong>${db.sales.length}</strong></div>
    <div class="fb"><span class="muted">Imports</span><strong>${db.importLog.length}</strong></div>
    <hr class="divider">
    <div class="fb"><span style="color:var(--accent2)">● Good</span><span class="muted">&lt;30%</span></div>
    <div class="fb"><span style="color:var(--warn)">● Watch</span><span class="muted">30–40%</span></div>
    <div class="fb"><span style="color:var(--danger)">● Over</span><span class="muted">&gt;40%</span></div>
  </div>`;
}

// ── SETTINGS ───────────────────────────────────────────────────────────────
function openModal_settings_init() {
  document.getElementById('settings-api-key').value = localStorage.getItem('rcc-api-key') || '';
}

// Override openModal to init settings fields
const _origOpenModal = openModal;
window.openModal = function(id) {
  _origOpenModal(id);
  if (id === 'modal-settings') openModal_settings_init();
};

function saveSettings() {
  // API key
  const key = document.getElementById('settings-api-key').value.trim();
  if (key) localStorage.setItem('rcc-api-key', key);
  else localStorage.removeItem('rcc-api-key');

  // Delivery commission rate
  const commission = parseFloat(document.getElementById('settings-commission').value);
  if (!isNaN(commission) && commission >= 0 && commission <= 100) {
    localStorage.setItem('rcc-delivery-commission', commission.toString());
  }

  // Delivery channel name
  const channel = document.getElementById('settings-channel').value.trim();
  if (channel) localStorage.setItem('rcc-delivery-channel', channel);

  // Square credentials
  const sqToken = document.getElementById('set-sq-token').value.trim();
  const sqLocation = document.getElementById('set-sq-location').value.trim();
  if (sqToken) localStorage.setItem('rcc-square-token', sqToken);
  else localStorage.removeItem('rcc-square-token');
  if (sqLocation) localStorage.setItem('rcc-square-location', sqLocation);
  else localStorage.removeItem('rcc-square-location');

  // Firebase URL
  const fbUrlVal = document.getElementById('settings-fb-url').value.trim();
  if (fbUrlVal) localStorage.setItem('rcc-fb-db-url', fbUrlVal);
  else localStorage.removeItem('rcc-fb-db-url');

  // Gmail invoice queue
  const gmailUrl = document.getElementById('settings-gmail-url').value.trim();
  if (gmailUrl) localStorage.setItem('rcc-gmail-webapp-url', gmailUrl);
  else localStorage.removeItem('rcc-gmail-webapp-url');
  const gmailWhitelist = document.getElementById('settings-gmail-whitelist').value.trim();
  if (gmailWhitelist) localStorage.setItem('rcc-gmail-whitelist', gmailWhitelist);
  else localStorage.removeItem('rcc-gmail-whitelist');

  closeModal('modal-settings');
  toast('Settings saved.');
}

// ── IMPORT PAGE ────────────────────────────────────────────────────────────
function renderImport() {
  // Set default date range: last 7 days (From = 6 days ago, To = today)
  const today = new Date();
  const from  = new Date(today); from.setDate(from.getDate() - 6);
  const toISO = d => d.toISOString().slice(0, 10);
  document.getElementById('sq-from').value = toISO(from);
  document.getElementById('sq-to').value   = toISO(today);
  renderImportLog();
  if (localStorage.getItem('rcc-gmail-webapp-url')) pollEmailQueue();
}

function switchSqTab(tab) {
  document.getElementById('sq-api-tab').style.display = tab === 'api' ? '' : 'none';
  document.getElementById('sq-csv-tab').style.display = tab === 'csv' ? '' : 'none';
  document.getElementById('sq-tab-api-btn').className = 'btn btn-sm ' + (tab === 'api' ? 'btn-primary' : 'btn-ghost');
  document.getElementById('sq-tab-csv-btn').className = 'btn btn-sm ' + (tab === 'csv' ? 'btn-primary' : 'btn-ghost');
}

function exportData() {
  const a = document.createElement('a');
  a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(db, null, 2));
  a.download = 'rcc-backup-' + todayStr() + '.json';
  a.click();
}

function importData(input) {
  const file = input.files[0]; if (!file) return; input.value = '';
  const r = new FileReader();
  r.onload = () => {
    try {
      const parsed = JSON.parse(r.result);
      if (!parsed.suppliers || !parsed.ingredients) throw new Error('Invalid backup file.');
      if (!confirm('This will replace ALL current data. Continue?')) return;
      db = parsed;
      saveDB();
      renderDashboard();
      closeModal('modal-settings');
      toast('Backup restored.');
    } catch(e) { toast('Import failed: ' + e.message, 'error'); }
  };
  r.readAsText(file);
}

// ── FIREBASE SYNC ──────────────────────────────────────────────────────────
function getFbUrl() { return (localStorage.getItem('rcc-fb-db-url') || '').replace(/\/$/, ''); }

async function syncIngredientsToFirebase() {
  const url = getFbUrl();
  if (!url) { toast('No Firebase URL set in Settings.', 'error'); return; }
  // Push minimal ingredient data needed by the tablet stock take page
  const payload = db.ingredients.map(i => {
    const lastPur = [...(i.purchases || [])].filter(p => !p.obsolete).slice(-1)[0];
    return {
      id: i.id,
      name: i.name,
      category: i.category || '',
      recipeUnit: i.recipeUnit,
      defaultUnit: lastPur ? lastPur.buyUnit : i.recipeUnit
    };
  });
  try {
    const res = await fetch(url + '/rcc/ingredients.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    toast(`${payload.length} ingredients synced to Firebase.`);
  } catch (e) { toast('Sync failed: ' + e.message, 'error'); }
}

async function importStockCountsFromFirebase() {
  const url = getFbUrl();
  if (!url) { toast('No Firebase URL set in Settings.', 'error'); return; }
  try {
    const res = await fetch(url + '/rcc/pendingCounts.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data) { toast('No pending stock counts found in Firebase.'); return; }
    const incoming = Object.values(data);
    const existingIds = new Set(db.stockCounts.map(s => s.id));
    let added = 0;
    incoming.forEach(c => {
      if (!existingIds.has(c.id)) { db.stockCounts.push(c); added++; }
    });
    if (!added) { toast('No new stock counts to import (all already imported).'); return; }
    await saveDB();
    renderInventory();
    closeModal('modal-settings');
    toast(`${added} stock count${added !== 1 ? 's' : ''} imported from Firebase.`);
  } catch (e) { toast('Import failed: ' + e.message, 'error'); }
}

// ── INIT ───────────────────────────────────────────────────────────────────
(async () => { await loadDB(); renderDashboard(); })();
