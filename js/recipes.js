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
    document.getElementById('recipe-cat').value  = r.category||'';
    document.getElementById('recipe-type').value = r.type;
    document.getElementById('recipe-yield').value = r.yield||'';
    document.getElementById('recipe-batch').checked = r.batchProduced || false;
    document.getElementById('recipe-batch-yield').value = r.batchYield || '';
    document.getElementById('recipe-output-unit').value = r.outputUnit || '';
    document.getElementById('recipe-sundry').value = r.sundryPct || 0;
    recipeLines = r.lines.map(l => ({...l, rowId: uid()}));
  } else {
    ['recipe-name','recipe-cat','recipe-yield'].forEach(x => document.getElementById(x).value = '');
    document.getElementById('recipe-type').value = 'menu';
    document.getElementById('recipe-batch').checked = false;
    document.getElementById('recipe-batch-yield').value = '';
    document.getElementById('recipe-output-unit').value = '';
    document.getElementById('recipe-sundry').value = 0;
  }
  toggleBatchYield();
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

function toggleBatchYield() {
  const isBatch = document.getElementById('recipe-batch').checked;
  document.getElementById('recipe-batch-yield-wrap').style.display = isBatch ? '' : 'none';
  updateRCP();
}

function updateRCP() {
  const raw = calcRecipeCost(recipeLines.map(l => ({ ref: l.ref, qty: l.qty })), false);
  const adj = calcRecipeCost(recipeLines.map(l => ({ ref: l.ref, qty: l.qty })), true);
  const pct = parseFloat(document.getElementById('recipe-sundry').value) || 0;
  const total = adj * (1 + pct / 100);
  const isBatch = document.getElementById('recipe-batch')?.checked;
  const batchYield = parseInt(document.getElementById('recipe-batch-yield')?.value) || 0;
  const cpp = (isBatch && batchYield > 0) ? total / batchYield : 0;
  document.getElementById('recipe-cost-preview').innerHTML =
    `WAC Cost: <strong style="color:var(--accent2)">$${fmt(raw)}</strong> &nbsp;|&nbsp; Yield-adjusted: <strong style="color:var(--danger)">$${fmt(adj)}</strong>` +
    (pct > 0 ? ` &nbsp;|&nbsp; +${fmt(pct,1)}% sundry: <strong style="color:var(--warn)">$${fmt(total)}</strong>` : '') +
    (cpp > 0 ? ` &nbsp;|&nbsp; Cost/portion: <strong style="color:var(--accent2)">$${fmt(cpp)}</strong>` : '');
}

function saveRecipe() {
  const name = document.getElementById('recipe-name').value.trim();
  if(!name) { toast('Name required.', 'error'); return; }
  const isBatch = document.getElementById('recipe-batch').checked;
  const obj = { id: editId||uid(), name,
    category:     document.getElementById('recipe-cat').value.trim(),
    type:         document.getElementById('recipe-type').value,
    yield:        document.getElementById('recipe-yield').value,
    batchProduced: isBatch,
    batchYield:   isBatch ? (parseInt(document.getElementById('recipe-batch-yield').value) || 1) : undefined,
    outputUnit:   isBatch ? (document.getElementById('recipe-output-unit').value.trim() || 'portions') : undefined,
    sundryPct: parseFloat(document.getElementById('recipe-sundry').value) || 0,
    lines: recipeLines.filter(l => l.ref).map(l => ({ ref: l.ref, qty: l.qty })) };
  if(editId) { const i = db.recipes.findIndex(x => x.id === editId); db.recipes[i] = obj; }
  else db.recipes.push(obj);
  saveDB(); closeModal('modal-recipe'); renderRecipes(); toast(editId ? 'Updated.' : 'Saved.'); editId = null;
}

function exportRecipesCSV() {
  const rows = [['Name', 'Type', 'Yield Note', 'Ingredients/Lines', 'Raw WAC Cost ($)', 'Yield-adj Cost ($)']];
  db.recipes.forEach(r => {
    const raw = calcRecipeCost(r.lines, false);
    const adj = calcRecipeCost(r.lines, true);
    const lineNames = (r.lines || []).map(l => {
      if (l.ref && l.ref.startsWith('ing:')) {
        const ing = db.ingredients.find(i => i.id === l.ref.slice(4));
        return ing ? `${ing.name} x${l.qty}${ing.recipeUnit}` : l.ref;
      }
      if (l.ref && l.ref.startsWith('rec:')) {
        const sub = db.recipes.find(x => x.id === l.ref.slice(4));
        return sub ? `[${sub.name}] x${l.qty}` : l.ref;
      }
      return '';
    }).join('; ');
    rows.push([r.name, r.type, r.yield || '', lineNames, fmt(raw), fmt(adj)]);
  });
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n'));
  a.download = `recipes_${todayStr()}.csv`;
  a.click();
}

function deleteRecipe(id) {
  if(!confirm('Delete?')) return;
  db.recipes = db.recipes.filter(x => x.id !== id);
  saveDB(); renderRecipes();
}

function renderRecipes() {
  const tb = document.getElementById('recipe-table');
  const q = (document.getElementById('recipe-search')?.value || '').toLowerCase();
  let list = db.recipes.filter(r =>
    !q || r.name.toLowerCase().includes(q) || (r.category||'').toLowerCase().includes(q)
  );
  list = sortApply(list, 'rec', (r, col) => ({
    name: r.name, cat: r.category||'', lines: r.lines.length,
    raw: calcRecipeCost(r.lines, false), adj: calcRecipeCost(r.lines, true)
  })[col] ?? r.name);
  applyHdrs('rec', {
    'th-rec-name': ['name','Name'], 'th-rec-cat': ['cat','Category'],
    'th-rec-lines': ['lines','Lines'], 'th-rec-raw': ['raw','Raw WAC Cost'], 'th-rec-adj': ['adj','Yield-adj Cost']
  });
  if(!list.length) {
    tb.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:28px">No recipes.</td></tr>'; return;
  }
  tb.innerHTML = list.map(r => {
    const raw = calcRecipeCost(r.lines, false), adj = calcRecipeCost(r.lines, true);
    const sundry = r.sundryPct || 0;
    const total  = adj * (1 + sundry / 100);
    return `<tr>
      <td><strong>${r.name}</strong>${r.yield ? `<div class="muted">${r.yield}</div>` : ''}${r.batchProduced && r.batchYield ? `<div class="muted" style="font-size:.74rem">${r.batchYield} portions/batch</div>` : ''}</td>
      <td>${r.category ? `<span class="badge bb">${r.category}</span>` : '<span class="muted">—</span>'}</td>
      <td>
        <span class="badge ${r.type==='base'?'bp':'bg'}">${r.type==='base'?'Sub-Recipe':'Menu'}</span>
        ${r.batchProduced ? '<span class="badge bw" style="margin-left:4px">Batch</span>' : ''}
      </td>
      <td>${r.lines.length}</td>
      <td style="color:var(--accent2)">$${fmt(raw)}</td>
      <td style="color:var(--danger)">$${fmt(adj)}${sundry > 0 ? `<div class="muted" style="font-size:.74rem">+${fmt(sundry,1)}% sundry → $${fmt(total)}</div>` : ''}</td>
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
  const ingCost = calcRecipeCost(rec.lines, true);
  const sundry  = rec.sundryPct || 0;
  const cost    = ingCost * (1 + sundry / 100);
  const pct     = price > 0 ? (cost/price*100) : 0;
  el.style.display = 'block';
  el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
    <div><div class="muted">Food Cost${sundry > 0 ? ` <span class="badge bw" style="font-size:.68rem">+${fmt(sundry,1)}% sundry</span>` : ' (yield-adj)'}</div><strong>$${fmt(cost)}</strong></div>
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
  const q = (document.getElementById('menu-search')?.value || '').toLowerCase();
  let list = db.menuItems.filter(m =>
    !q || m.name.toLowerCase().includes(q) || (m.category||'').toLowerCase().includes(q)
  );
  // Pre-compute cost values for sorting
  const withCost = list.map(m => {
    const rec     = db.recipes.find(r => r.id === m.recipeId);
    const ingCost = rec ? calcRecipeCost(rec.lines, true) : 0;
    const sundry  = rec ? (rec.sundryPct || 0) : 0;
    const cost    = ingCost * (1 + sundry / 100);
    const pct     = m.price > 0 ? (cost/m.price*100) : 0;
    return { m, rec, cost, pct, profit: m.price - cost };
  });
  const sorted = sortApply(withCost, 'menu', (x, col) => ({
    name: x.m.name, cat: x.m.category||'', sell: x.m.price,
    cost: x.cost, pct: x.pct, profit: x.profit
  })[col] ?? x.m.name);
  applyHdrs('menu', {
    'th-menu-name': ['name','Item'], 'th-menu-cat': ['cat','Category'],
    'th-menu-sell': ['sell','Sell $'], 'th-menu-cost': ['cost','Food Cost'],
    'th-menu-pct': ['pct','Cost %'], 'th-menu-profit': ['profit','Gross Profit']
  });
  if(!sorted.length) {
    tb.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:28px">No menu items.</td></tr>';
  } else {
    tb.innerHTML = sorted.map(({ m, rec, cost, pct }) => {
      return `<tr>
        <td><strong>${m.name}</strong></td>
        <td>${m.category ? `<span class="badge bb">${m.category}</span>` : '<span class="muted">—</span>'}</td>
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
  if (typeof renderModifierLinks === 'function') renderModifierLinks();
}
