// ── RECIPE COSTING ─────────────────────────────────────────────────────────
function calcRecipeCost(lines, useYield=true) {
  return (lines||[]).reduce((sum, l) => {
    if(!l.ref || !l.qty) return sum;
    if(l.ref.startsWith('ing:')) {
      const ing = db.ingredients.find(i => i.id === l.ref.slice(4));
      if(!ing) return sum;
      return sum + (useYield ? effectiveCost(ing) : (ing.wac||0)) * l.qty;
    }
    const rec = db.recipes.find(r => r.id === l.ref.slice(4));
    return sum + (rec ? calcRecipeCost(rec.lines, useYield) * l.qty : 0);
  }, 0);
}

// ── RECIPE MODAL ───────────────────────────────────────────────────────────
function openRecipeModal(id=null) {
  editId = id; recipeLines = [];
  document.getElementById('recipe-modal-title').textContent = id ? 'Edit Recipe' : 'Create Recipe';
  if(id) {
    const r = db.recipes.find(x => x.id === id);
    document.getElementById('recipe-name').value = r.name;
    document.getElementById('recipe-type').value = r.type;
    document.getElementById('recipe-yield').value = r.yield||'';
    recipeLines = r.lines.map(l => ({...l, rowId: uid()}));
  } else {
    ['recipe-name','recipe-yield'].forEach(x => document.getElementById(x).value = '');
    document.getElementById('recipe-type').value = 'menu';
  }
  renderRLs(); openModal('modal-recipe');
}

function addRL()         { recipeLines.push({ rowId: uid(), ref: '', qty: 0 }); renderRLs(); }
function removeRL(i)     { recipeLines.splice(i, 1); renderRLs(); }

function buildRefOpts() {
  const ings = db.ingredients.map(i => `<option value="ing:${i.id}">${i.name} (${i.recipeUnit})</option>`).join('');
  const recs  = db.recipes.map(r    => `<option value="rec:${r.id}">${r.name}</option>`).join('');
  return `<option value="">—</option><optgroup label="Ingredients">${ings}</optgroup><optgroup label="Sub-Recipes">${recs}</optgroup>`;
}

function getRLUnit(ref) {
  if(!ref) return '';
  if(ref.startsWith('ing:')) { const i = db.ingredients.find(x => x.id === ref.slice(4)); return i ? i.recipeUnit : ''; }
  return 'portion';
}

function renderRLs() {
  const el = document.getElementById('recipe-lines');
  if(!recipeLines.length) { el.innerHTML = '<div class="muted" style="padding:10px 0">No lines yet.</div>'; updateRCP(); return; }
  el.innerHTML = recipeLines.map((l, i) => `
    <div style="display:grid;grid-template-columns:2fr 120px 70px auto;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
      <select onchange="setRL(${i},'ref',this.value)">${buildRefOpts()}</select>
      <input type="number" step="0.1" placeholder="Qty" value="${l.qty||''}" onchange="setRL(${i},'qty',parseFloat(this.value)||0)">
      <span class="muted">${getRLUnit(l.ref)}</span>
      <button class="btn btn-danger btn-sm" onclick="removeRL(${i})">✕</button>
    </div>`).join('');
  recipeLines.forEach((l, i) => { const s = el.querySelectorAll('select')[i]; if(l.ref) s.value = l.ref; });
  updateRCP();
}

function setRL(i, k, v) { recipeLines[i][k] = v; if(k === 'ref') renderRLs(); else updateRCP(); }

function updateRCP() {
  const raw = calcRecipeCost(recipeLines.map(l => ({ ref: l.ref, qty: l.qty })), false);
  const adj = calcRecipeCost(recipeLines.map(l => ({ ref: l.ref, qty: l.qty })), true);
  document.getElementById('recipe-cost-preview').innerHTML =
    `WAC Cost: <strong style="color:var(--accent2)">$${fmt(raw)}</strong> &nbsp;|&nbsp; Yield-adjusted: <strong style="color:var(--danger)">$${fmt(adj)}</strong>`;
}

function saveRecipe() {
  const name = document.getElementById('recipe-name').value.trim();
  if(!name) { toast('Name required.', 'error'); return; }
  const obj = { id: editId||uid(), name,
    type:  document.getElementById('recipe-type').value,
    yield: document.getElementById('recipe-yield').value,
    lines: recipeLines.filter(l => l.ref).map(l => ({ ref: l.ref, qty: l.qty })) };
  if(editId) { const i = db.recipes.findIndex(x => x.id === editId); db.recipes[i] = obj; }
  else db.recipes.push(obj);
  saveDB(); closeModal('modal-recipe'); renderRecipes(); toast(editId ? 'Updated.' : 'Saved.'); editId = null;
}

function deleteRecipe(id) {
  if(!confirm('Delete?')) return;
  db.recipes = db.recipes.filter(x => x.id !== id);
  saveDB(); renderRecipes();
}

function renderRecipes() {
  const tb = document.getElementById('recipe-table');
  if(!db.recipes.length) {
    tb.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:28px">No recipes.</td></tr>'; return;
  }
  tb.innerHTML = db.recipes.map(r => {
    const raw = calcRecipeCost(r.lines, false), adj = calcRecipeCost(r.lines, true);
    return `<tr>
      <td><strong>${r.name}</strong>${r.yield ? `<div class="muted">${r.yield}</div>` : ''}</td>
      <td><span class="badge ${r.type==='base'?'bp':'bg'}">${r.type==='base'?'Sub-Recipe':'Menu'}</span></td>
      <td>${r.lines.length}</td>
      <td style="color:var(--accent2)">$${fmt(raw)}</td>
      <td style="color:var(--danger)">$${fmt(adj)}</td>
      <td class="flex">
        <button class="btn btn-ghost btn-sm" onclick="openRecipeModal('${r.id}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteRecipe('${r.id}')">Del</button>
      </td>
    </tr>`;
  }).join('');
}

// ── MENU ───────────────────────────────────────────────────────────────────
function openMenuModal(id=null) {
  editId = id;
  const sel = document.getElementById('menu-recipe');
  sel.innerHTML = '<option value="">— Select —</option>' + db.recipes.map(r => `<option value="${r.id}">${r.name}</option>`).join('');
  if(id) {
    const m = db.menuItems.find(x => x.id === id);
    document.getElementById('menu-name').value = m.name;
    document.getElementById('menu-price').value = m.price;
    document.getElementById('menu-cat').value = m.category||'';
    sel.value = m.recipeId;
    updateMenuPreview();
  } else {
    ['menu-name','menu-price','menu-cat'].forEach(x => document.getElementById(x).value = '');
    document.getElementById('menu-preview').style.display = 'none';
  }
  document.getElementById('menu-modal-title').textContent = id ? 'Edit Item' : 'Add Menu Item';
  openModal('modal-menu');
}

function updateMenuPreview() {
  const rId   = document.getElementById('menu-recipe').value;
  const price = parseFloat(document.getElementById('menu-price').value)||0;
  const el    = document.getElementById('menu-preview');
  if(!rId) { el.style.display = 'none'; return; }
  const rec = db.recipes.find(r => r.id === rId); if(!rec) return;
  const cost = calcRecipeCost(rec.lines, true), pct = price > 0 ? (cost/price*100) : 0;
  el.style.display = 'block';
  el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
    <div><div class="muted">Food Cost (yield-adj)</div><strong>$${fmt(cost)}</strong></div>
    <div><div class="muted">Cost %</div><strong style="color:${pctCol(pct)}">${fmt(pct,1)}%</strong></div>
    <div><div class="muted">Gross Profit</div><strong style="color:var(--accent2)">$${fmt(price-cost)}</strong></div>
  </div><div class="pbar" style="margin-top:8px"><div class="pfill" style="width:${Math.min(pct,100)}%;background:${pctCol(pct)}"></div></div>`;
}

function saveMenuItem() {
  const name     = document.getElementById('menu-name').value.trim();
  const price    = parseFloat(document.getElementById('menu-price').value);
  const recipeId = document.getElementById('menu-recipe').value;
  if(!name || isNaN(price) || !recipeId) { toast('All fields required.', 'error'); return; }
  const obj = { id: editId||uid(), name, price, recipeId, category: document.getElementById('menu-cat').value };
  if(editId) { const i = db.menuItems.findIndex(x => x.id === editId); db.menuItems[i] = obj; }
  else db.menuItems.push(obj);
  saveDB(); closeModal('modal-menu'); renderMenu(); toast(editId ? 'Updated.' : 'Added.'); editId = null;
}

function deleteMenuItem(id) {
  if(!confirm('Delete?')) return;
  db.menuItems = db.menuItems.filter(x => x.id !== id);
  saveDB(); renderMenu();
}

function renderMenu() {
  const tb = document.getElementById('menu-table');
  if(!db.menuItems.length) {
    tb.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:28px">No menu items.</td></tr>'; return;
  }
  tb.innerHTML = db.menuItems.map(m => {
    const rec  = db.recipes.find(r => r.id === m.recipeId);
    const cost = rec ? calcRecipeCost(rec.lines, true) : 0;
    const pct  = m.price > 0 ? (cost/m.price*100) : 0;
    return `<tr>
      <td><strong>${m.name}</strong>${m.category ? `<div class="muted">${m.category}</div>` : ''}</td>
      <td>${rec ? rec.name : '<span style="color:var(--danger)">No recipe</span>'}</td>
      <td>$${fmt(m.price)}</td><td>$${fmt(cost)}</td>
      <td><span class="badge ${pctCls(pct)}">${fmt(pct,1)}%</span></td>
      <td style="color:var(--accent2)">$${fmt(m.price-cost)}</td>
      <td class="flex">
        <button class="btn btn-ghost btn-sm" onclick="openMenuModal('${m.id}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteMenuItem('${m.id}')">Del</button>
      </td>
    </tr>`;
  }).join('');
}
