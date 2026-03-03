// ── STORAGE POLYFILL (localStorage fallback for window.storage) ────────────
if (!window.storage) {
  window.storage = {
    set: (key, val) => Promise.resolve(localStorage.setItem(key, val)),
    get: (key) => {
      const v = localStorage.getItem(key);
      return Promise.resolve(v != null ? { value: v } : null);
    }
  };
}

// ── STATE ──────────────────────────────────────────────────────────────────
let db = {
  suppliers:     [],
  ingredients:   [],
  recipes:       [],
  menuItems:     [],
  sales:         [],
  importLog:     [],
  modifierLinks:      [],  // [{ pattern, type, ingredientId, qty, unit, extraCost }]
  stockCounts:        [],  // [{ id, dateFrom, dateTo, note, lines: [{ingredientId, openQty, openUnit, closeQty, closeUnit}] }]
  productionBatches:  []   // [{ id, date, recipeId, portionsProduced, note }]
};

// ── STORAGE ────────────────────────────────────────────────────────────────
async function saveDB() {
  try { await window.storage.set('rcc-v4', JSON.stringify(db)); } catch(e) {}
}
async function loadDB() {
  try {
    const r = await window.storage.get('rcc-v4');
    if (r) {
      db = JSON.parse(r.value);
      // Migration: ensure new collections exist for older saved data
      if (!db.stockCounts)        db.stockCounts        = [];
      if (!db.productionBatches)  db.productionBatches  = [];
      if (!db.modifierLinks) {
        // Migrate old modifierCosts if present, otherwise start fresh
        if (db.modifierCosts && db.modifierCosts.length) {
          db.modifierLinks = db.modifierCosts.map(mc => ({
            pattern: mc.name, type: mc.name.startsWith('+') ? 'add' : mc.name.toLowerCase().startsWith('no ') ? 'remove' : 'neutral',
            ingredientId: null, qty: 0, unit: 'g', extraCost: mc.extraCost || 0
          }));
        } else {
          db.modifierLinks = [];
        }
      }
    }
  } catch(e) {}
}

// ── SORT HELPERS ─────────────────────────────────────────────────────────────
const _tSort = {};
function sortTbl(key, col, fn) {
  const s = _tSort[key] || {};
  _tSort[key] = { col, dir: s.col === col ? -s.dir : 1 };
  fn();
}
function sortApply(arr, key, getVal) {
  const s = _tSort[key];
  if (!s || !s.col) return arr;
  return [...arr].sort((a, b) => {
    const va = getVal(a, s.col), vb = getVal(b, s.col);
    if (typeof va === 'string') return va.localeCompare(vb) * s.dir;
    return (va - vb) * s.dir;
  });
}
function sortHdr(key, col, label) {
  const s = _tSort[key];
  const active = s && s.col === col;
  const icon = active ? (s.dir === 1 ? '▲' : '▼') : '⇅';
  return `${label}<span style="font-size:.65em;opacity:${active?1:.25};margin-left:3px">${icon}</span>`;
}
function applyHdrs(key, map) {
  Object.entries(map).forEach(([id, [col, label]]) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = sortHdr(key, col, label);
  });
}

// ── UTILS ──────────────────────────────────────────────────────────────────
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const fmt = (n, d=2) => parseFloat(n||0).toFixed(d);
const pctCol = p => p < 30 ? 'var(--accent2)' : p < 40 ? 'var(--warn)' : 'var(--danger)';
const pctCls = p => p < 30 ? 'bg' : p < 40 ? 'bw' : 'br';
const todayStr = () => new Date().toISOString().slice(0, 10);

const BUY_UNITS  = ['carton','case','bag','box','each','dozen','kg','L','lb','g','ml'];
const PACK_UNITS = ['g','ml','kg','L'];

function buyUnitSel(sel='each', id='') {
  return `<select${id ? ' id="'+id+'"' : ''}>${BUY_UNITS.map(u => `<option${u===sel?' selected':''}>${u}</option>`).join('')}</select>`;
}
function packUnitSel(sel='g', id='') {
  return `<select${id ? ' id="'+id+'"' : ''}>${PACK_UNITS.map(u => `<option${u===sel?' selected':''}>${u}</option>`).join('')}</select>`;
}