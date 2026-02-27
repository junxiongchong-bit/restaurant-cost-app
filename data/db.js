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
let db = { suppliers: [], ingredients: [], recipes: [], menuItems: [], sales: [], importLog: [] };

// ── STORAGE ────────────────────────────────────────────────────────────────
async function saveDB() {
  try { await window.storage.set('rcc-v4', JSON.stringify(db)); } catch(e) {}
}
async function loadDB() {
  try { const r = await window.storage.get('rcc-v4'); if(r) db = JSON.parse(r.value); } catch(e) {}
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
