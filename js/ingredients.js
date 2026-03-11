// ── WAC CORE ───────────────────────────────────────────────────────────────
function calcCPU(price, qty, packCount, packSize, packUnit, buyUnit) {
  const bq = parseFloat(qty)||1, bp = parseFloat(price)||0;
  const pc = parseFloat(packCount)||0, ps = parseFloat(packSize)||0;
  if(pc > 0 && ps > 0) {
    let sz = ps;
    if(packUnit === 'kg' || packUnit === 'L') sz *= 1000;
    // 'each' pack unit: sz stays as-is (1 each = 1 base unit)
    const t = bq * pc * sz;
    return t > 0 ? bp / t : null;
  }
  if(['kg','g','L','ml'].includes(buyUnit)) {
    let t = bq; if(buyUnit === 'kg' || buyUnit === 'L') t *= 1000;
    return t > 0 ? bp / t : null;
  }
  return bq > 0 ? bp / bq : null;
}

function getBaseUnits(qty, packCount, packSize, packUnit, buyUnit) {
  const bq = parseFloat(qty)||1, pc = parseFloat(packCount)||0, ps = parseFloat(packSize)||0;
  if(pc > 0 && ps > 0) {
    let sz = ps; if(packUnit === 'kg' || packUnit === 'L') sz *= 1000; return bq * pc * sz;
  }
  if(['kg','g','L','ml'].includes(buyUnit)) {
    let t = bq; if(buyUnit === 'kg' || buyUnit === 'L') t *= 1000; return t;
  }
  return bq;
}

// Recalc WAC from scratch using only active purchases
function recalcWAC(ing) {
  const active = (ing.purchases||[]).filter(p => !p.obsolete);
  if(!active.length) { ing.wac = 0; ing.totalBaseUnits = 0; return; }
  let totalVal = 0, totalUnits = 0;
  active.forEach(p => {
    totalVal  += parseFloat(p.totalPrice)||0;
    totalUnits += parseFloat(p.baseUnits)||0;
  });
  ing.wac = totalUnits > 0 ? totalVal / totalUnits : 0;
  ing.totalBaseUnits = totalUnits;
}

function effectiveCost(ing) {
  const y = parseFloat(ing.yield)||100;
  return (ing.wac||0) / (y / 100);
}

// ── INGREDIENT MODAL ───────────────────────────────────────────────────────
function openIngModal() {
  editId = null;
  ['ing-name','ing-cat','ing-buy-qty','ing-buy-price','ing-pack-count','ing-pack-size']
    .forEach(x => document.getElementById(x).value = '');
  document.getElementById('ing-yield').value = 100;
  document.getElementById('ing-ru').value = 'g';
  document.getElementById('ing-buy-unit').value = 'each';
  document.getElementById('ing-pack-unit').value = 'g';
  document.getElementById('ing-impact').value = '';
  document.getElementById('ing-wac-preview').style.display = 'none';
  populateSupSel('ing-sup');
  document.getElementById('ing-modal-title').textContent = 'Add Ingredient';
  openModal('modal-ing');
}

function calcIngWAC() {
  const bp = parseFloat(document.getElementById('ing-buy-price').value)||0;
  if(!bp) { document.getElementById('ing-wac-preview').style.display = 'none'; return; }
  const bq = parseFloat(document.getElementById('ing-buy-qty').value)||1;
  const pc = document.getElementById('ing-pack-count').value;
  const ps = document.getElementById('ing-pack-size').value;
  const pu = document.getElementById('ing-pack-unit').value;
  const bu = document.getElementById('ing-buy-unit').value;
  const yld = parseFloat(document.getElementById('ing-yield').value)||100;
  const ru  = document.getElementById('ing-ru').value;
  const cpu = calcCPU(bp, bq, pc, ps, pu, bu);
  const prev = document.getElementById('ing-wac-preview');
  if(cpu != null) {
    const eff = cpu / (yld / 100);
    prev.style.display = 'block';
    prev.innerHTML = `WAC: <strong style="color:var(--accent2)">$${cpu.toFixed(5)}/${ru}</strong> &nbsp;|&nbsp; Yield-adj effective: <strong style="color:var(--warn)">$${eff.toFixed(5)}/${ru}</strong>`;
  } else {
    prev.style.display = 'none';
  }
}

function saveIngredient() {
  const name = document.getElementById('ing-name').value.trim();
  if(!name) { toast('Name required.', 'error'); return; }
  const bp = parseFloat(document.getElementById('ing-buy-price').value)||0;
  const bq = parseFloat(document.getElementById('ing-buy-qty').value)||1;
  const pc = document.getElementById('ing-pack-count').value;
  const ps = document.getElementById('ing-pack-size').value;
  const pu = document.getElementById('ing-pack-unit').value;
  const bu = document.getElementById('ing-buy-unit').value;
  const ru = document.getElementById('ing-ru').value;
  const yld = parseFloat(document.getElementById('ing-yield').value)||100;
  let cpu = null, baseUnits = 0, purs = [];
  if(bp > 0) {
    cpu = calcCPU(bp, bq, pc, ps, pu, bu);
    if(!cpu) { toast('Cannot calculate cost — check pack details.', 'error'); return; }
    baseUnits = getBaseUnits(bq, pc, ps, pu, bu);
    purs = [{ id: uid(), date: todayStr(), supplierId: document.getElementById('ing-sup').value,
      buyUnit: bu, buyQty: bq, packCount: parseFloat(pc)||null, packSize: parseFloat(ps)||null,
      packUnit: pu, totalPrice: bp, cpru: cpu, baseUnits, obsolete: false }];
  }
  db.ingredients.push({ id: uid(), name, category: document.getElementById('ing-cat').value,
    supplierId: document.getElementById('ing-sup').value, recipeUnit: ru, yield: yld,
    costImpact: document.getElementById('ing-impact').value || '',
    wac: cpu||0, totalBaseUnits: baseUnits, purchases: purs });
  saveDB(); closeModal('modal-ing'); renderIngredients(); toast('Ingredient added.');
}

function exportIngredientsCSV() {
  const rows = [['Name', 'Category', 'Supplier', 'Recipe Unit', 'Yield %', 'WAC per RU', 'Effective Cost per RU', 'Active Purchases']];
  db.ingredients.forEach(i => {
    const sup = db.suppliers.find(s => s.id === i.supplierId);
    const eff = effectiveCost(i);
    rows.push([
      i.name,
      i.category || '',
      sup ? sup.name : '',
      i.recipeUnit,
      i.yield || 100,
      fmt(i.wac || 0, 5),
      fmt(eff, 5),
      (i.purchases || []).filter(p => !p.obsolete).length
    ]);
  });
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n'));
  a.download = `ingredients_${todayStr()}.csv`;
  a.click();
}

function deleteIngredient(id) {
  if(!confirm('Delete?')) return;
  db.ingredients = db.ingredients.filter(x => x.id !== id);
  saveDB(); renderIngredients();
}

// ── INGREDIENT DETAIL ──────────────────────────────────────────────────────
function openIngDetail(id) {
  detailIngId = id;
  const ing = db.ingredients.find(x => x.id === id);
  document.getElementById('ing-detail-title').textContent = ing.name + (ing.category ? ' — ' + ing.category : '') + ' — Detail';
  document.getElementById('detail-name').value   = ing.name;
  document.getElementById('detail-cat').value    = ing.category || '';
  document.getElementById('detail-ru').value     = ing.recipeUnit || 'g';
  document.getElementById('detail-yield').value  = ing.yield || 100;
  document.getElementById('detail-impact').value = ing.costImpact || '';
  document.getElementById('detail-yield-preview').style.display = 'none';
  populateSupSel('detail-sup', ing.supplierId || '');
  populateSupSel('pur-sup', ing.supplierId||'');
  document.getElementById('pur-date').value = todayStr();
  ['pur-qty','pur-pack-count','pur-pack-size','pur-price'].forEach(x => document.getElementById(x).value = '');
  document.getElementById('pur-buy-unit').value = 'each';
  document.getElementById('pur-pack-unit').value = 'g';
  document.getElementById('pur-wac-preview').style.display = 'none';
  editPurId = null;
  document.getElementById('pur-form-title').textContent = '+ Add New Purchase';
  document.getElementById('pur-cancel-edit').style.display = 'none';
  document.getElementById('pur-save-btn').textContent = 'Add Purchase & Update WAC';
  renderIngDetailTop(ing);
  renderPurchaseHistory(ing);
  openModal('modal-ing-detail');
}

function saveIngredientInfo() {
  const ing = db.ingredients.find(x => x.id === detailIngId); if (!ing) return;
  const name = document.getElementById('detail-name').value.trim();
  if (!name) { toast('Name required.', 'error'); return; }
  ing.name       = name;
  ing.category   = document.getElementById('detail-cat').value.trim();
  ing.supplierId = document.getElementById('detail-sup').value;
  ing.recipeUnit = document.getElementById('detail-ru').value;
  ing.yield      = parseFloat(document.getElementById('detail-yield').value) || 100;
  ing.costImpact = document.getElementById('detail-impact').value || '';
  recalcWAC(ing);
  document.getElementById('ing-detail-title').textContent = ing.name + (ing.category ? ' — ' + ing.category : '') + ' — Detail';
  saveDB(); renderIngDetailTop(ing); renderIngredients();
  toast('Ingredient updated.');
}

function renderIngDetailTop(ing) {
  const eff = effectiveCost(ing);
  document.getElementById('ing-detail-top').innerHTML = `
    <div class="cb"><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
      <div><div class="muted">WAC /${ing.recipeUnit}</div><strong style="color:var(--accent2)">$${(ing.wac||0).toFixed(5)}</strong></div>
      <div><div class="muted">Yield</div><strong style="color:var(--warn)">${ing.yield||100}%</strong></div>
      <div><div class="muted">Effective Cost/${ing.recipeUnit}</div><strong style="color:var(--danger)">$${eff.toFixed(5)}</strong></div>
      <div><div class="muted">Active Purchases</div><strong>${(ing.purchases||[]).filter(p=>!p.obsolete).length} / ${(ing.purchases||[]).length}</strong></div>
    </div></div>`;
}

function previewYield() {
  const ing = db.ingredients.find(x => x.id === detailIngId); if(!ing) return;
  const y = parseFloat(document.getElementById('detail-yield').value)||100;
  const eff = (ing.wac||0) / (y / 100);
  const el = document.getElementById('detail-yield-preview');
  el.style.display = 'block';
  el.innerHTML = `New effective cost: <strong style="color:var(--danger)">$${eff.toFixed(5)}/${ing.recipeUnit}</strong>`;
}

function saveYield() {
  const ing = db.ingredients.find(x => x.id === detailIngId); if(!ing) return;
  ing.yield = parseFloat(document.getElementById('detail-yield').value)||100;
  saveDB(); renderIngDetailTop(ing); renderIngredients(); toast('Yield updated.');
}

function renderPurchaseHistory(ing) {
  const supName = id => db.suppliers.find(s => s.id === id)?.name || '—';
  const el = document.getElementById('ing-purchases');
  if(!(ing.purchases||[]).length) {
    el.innerHTML = '<div class="muted" style="padding:12px">No purchases yet.</div>'; return;
  }

  // Variance hint: flag active purchases whose cpru deviates >20% from WAC
  const wac = ing.wac || 0;
  const THRESHOLD = 0.20;

  const reversed = [...ing.purchases].reverse();
  el.innerHTML = `<table>
    <thead><tr><th>Date</th><th>Invoice</th><th>Supplier</th><th>Qty/Unit</th><th>Pack Detail</th><th>Total $</th><th>Cost/${ing.recipeUnit}</th><th>Status</th><th>Action</th></tr></thead>
    <tbody>${reversed.map((p) => {
      const realIdx = ing.purchases.findIndex(x => x.id === p.id);

      let cpruCell;
      if(p.cpru != null) {
        const variance = wac > 0 ? (p.cpru - wac) / wac : 0;
        const pct      = (variance * 100).toFixed(1);
        const over     = !p.obsolete && Math.abs(variance) > THRESHOLD;
        const color    = over ? (variance > 0 ? 'var(--danger)' : 'var(--accent2)') : 'var(--accent2)';
        const hint     = over
          ? ` <span title="${variance > 0 ? 'Above' : 'Below'} WAC by ${Math.abs(pct)}%" style="cursor:default;font-size:.75rem;color:${color}">⚠ ${variance > 0 ? '+' : ''}${pct}%</span>`
          : '';
        cpruCell = `<td style="color:${color}">${p.cpru.toFixed(5)}${hint}</td>`;
      } else {
        cpruCell = `<td style="color:var(--accent2)">—</td>`;
      }

      return `<tr class="${p.obsolete ? 'obs-row' : ''}">
        <td>${p.date}</td>
        <td style="color:var(--muted);font-size:.8rem">${p.invoiceNo || '—'}</td>
        <td>${supName(p.supplierId)}</td>
        <td>${p.buyQty||1} ${p.buyUnit||''}</td>
        <td>${p.packCount && p.packSize ? `${p.packCount}×${p.packSize}${p.packUnit}` : '—'}</td>
        <td>${fmt(p.totalPrice)}</td>
        ${cpruCell}
        <td>${p.obsolete
          ? '<span class="badge bobs">Obsolete</span>'
          : '<span class="badge bg">Active</span>'}</td>
        <td>
          ${p.obsolete
            ? `<button class="btn btn-ghost btn-sm" onclick="toggleObsoleteByIdx(${realIdx},false)">Reactivate</button>`
            : `<button class="btn btn-warn btn-sm" onclick="toggleObsoleteByIdx(${realIdx},true)">Mark Obsolete</button>`
          }
          <button class="btn btn-ghost btn-sm" onclick="editPurchase('${p.id}')">Edit</button>
        </td>
      </tr>`;
    }).join('')}
    </tbody></table>`;
}

function toggleObsoleteByIdx(purIdx, makeObsolete) {
  const ing = db.ingredients.find(x => x.id === detailIngId);
  if(!ing) { toast('Ingredient not found.', 'error'); return; }
  if(purIdx < 0 || purIdx >= ing.purchases.length) { toast('Purchase not found.', 'error'); return; }
  const pur = ing.purchases[purIdx];
  if(makeObsolete) {
    const activeCount = ing.purchases.filter(p => !p.obsolete).length;
    if(activeCount <= 1) { toast('Cannot obsolete the only active purchase.', 'error'); return; }
    if(!confirm('Mark as obsolete? WAC will recalculate from remaining active entries.')) return;
  }
  pur.obsolete = makeObsolete;
  recalcWAC(ing);
  saveDB();
  renderIngDetailTop(ing);
  renderPurchaseHistory(ing);
  renderIngredients();
  toast(makeObsolete ? 'Marked obsolete. WAC recalculated.' : 'Reactivated. WAC recalculated.');
}

function calcPurWAC() {
  const ing = db.ingredients.find(x => x.id === detailIngId); if(!ing) return;
  const bp = parseFloat(document.getElementById('pur-price').value)||0;
  if(!bp) { document.getElementById('pur-wac-preview').style.display = 'none'; return; }
  const bq = parseFloat(document.getElementById('pur-qty').value)||1;
  const pc = document.getElementById('pur-pack-count').value;
  const ps = document.getElementById('pur-pack-size').value;
  const pu = document.getElementById('pur-pack-unit').value;
  const bu = document.getElementById('pur-buy-unit').value;
  const cpu = calcCPU(bp, bq, pc, ps, pu, bu);
  const prev = document.getElementById('pur-wac-preview');
  if(cpu != null) {
    const newBase  = getBaseUnits(bq, pc, ps, pu, bu);
    const activeUnits = ing.totalBaseUnits||0;
    const activeVal   = (ing.wac||0) * activeUnits;
    const newWAC  = (activeVal + bp) / (activeUnits + newBase);
    prev.style.display = 'block';
    prev.innerHTML = `This purchase: <strong style="color:var(--accent2)">$${cpu.toFixed(5)}/${ing.recipeUnit}</strong>
    &nbsp;|&nbsp; Updated WAC: <strong style="color:var(--warn)">$${newWAC.toFixed(5)}</strong>
    &nbsp;|&nbsp; Effective: <strong style="color:var(--danger)">$${(newWAC/((ing.yield||100)/100)).toFixed(5)}</strong>`;
  } else {
    prev.style.display = 'none';
  }
}

function editPurchase(purId) {
  const ing = db.ingredients.find(x => x.id === detailIngId); if(!ing) return;
  const p = ing.purchases.find(x => x.id === purId); if(!p) return;
  editPurId = purId;
  document.getElementById('pur-date').value = p.date || todayStr();
  document.getElementById('pur-invoice-no').value = p.invoiceNo || '';
  populateSupSel('pur-sup', p.supplierId || '');
  document.getElementById('pur-buy-unit').value = p.buyUnit || 'each';
  document.getElementById('pur-qty').value = p.buyQty || 1;
  document.getElementById('pur-pack-count').value = p.packCount || '';
  document.getElementById('pur-pack-size').value = p.packSize || '';
  document.getElementById('pur-pack-unit').value = p.packUnit || 'g';
  document.getElementById('pur-price').value = p.totalPrice || '';
  document.getElementById('pur-form-title').textContent = '✏ Edit Purchase';
  document.getElementById('pur-cancel-edit').style.display = '';
  document.getElementById('pur-save-btn').textContent = 'Update Purchase & Recalculate WAC';
  calcPurWAC();
  document.getElementById('pur-date').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cancelEditPurchase() {
  editPurId = null;
  ['pur-qty','pur-pack-count','pur-pack-size','pur-price','pur-invoice-no'].forEach(x => document.getElementById(x).value = '');
  document.getElementById('pur-date').value = todayStr();
  document.getElementById('pur-buy-unit').value = 'each';
  document.getElementById('pur-pack-unit').value = 'g';
  document.getElementById('pur-wac-preview').style.display = 'none';
  document.getElementById('pur-form-title').textContent = '+ Add New Purchase';
  document.getElementById('pur-cancel-edit').style.display = 'none';
  document.getElementById('pur-save-btn').textContent = 'Add Purchase & Update WAC';
}

function addPurchase() {
  const ing = db.ingredients.find(x => x.id === detailIngId); if(!ing) return;
  const bp = parseFloat(document.getElementById('pur-price').value)||0;
  if(!bp) { toast('Enter invoice price.', 'error'); return; }
  const bq = parseFloat(document.getElementById('pur-qty').value)||1;
  const pc = document.getElementById('pur-pack-count').value;
  const ps = document.getElementById('pur-pack-size').value;
  const pu = document.getElementById('pur-pack-unit').value;
  const bu = document.getElementById('pur-buy-unit').value;
  const cpu = calcCPU(bp, bq, pc, ps, pu, bu);
  if(!cpu) { toast('Cannot calculate cost — check pack details.', 'error'); return; }
  const baseUnits = getBaseUnits(bq, pc, ps, pu, bu);
  if(editPurId) {
    const pur = ing.purchases.find(x => x.id === editPurId);
    if(!pur) { toast('Purchase not found.', 'error'); return; }
    pur.date = document.getElementById('pur-date').value || todayStr();
    pur.supplierId = document.getElementById('pur-sup').value;
    pur.invoiceNo = document.getElementById('pur-invoice-no').value.trim() || null;
    pur.buyUnit = bu; pur.buyQty = bq;
    pur.packCount = parseFloat(pc)||null; pur.packSize = parseFloat(ps)||null; pur.packUnit = pu;
    pur.totalPrice = bp; pur.cpru = cpu; pur.baseUnits = baseUnits;
    cancelEditPurchase();
    toast('Purchase updated & WAC recalculated.');
  } else {
    const pur = { id: uid(), date: document.getElementById('pur-date').value||todayStr(),
      supplierId: document.getElementById('pur-sup').value,
      invoiceNo: document.getElementById('pur-invoice-no').value.trim() || null,
      buyUnit: bu, buyQty: bq,
      packCount: parseFloat(pc)||null, packSize: parseFloat(ps)||null, packUnit: pu,
      totalPrice: bp, cpru: cpu, baseUnits, obsolete: false };
    if(!ing.purchases) ing.purchases = [];
    ing.purchases.push(pur);
    ['pur-qty','pur-pack-count','pur-pack-size','pur-price'].forEach(x => document.getElementById(x).value = '');
    document.getElementById('pur-wac-preview').style.display = 'none';
    toast('Purchase added & WAC updated.');
  }
  recalcWAC(ing);
  saveDB(); renderIngDetailTop(ing); renderPurchaseHistory(ing); renderIngredients();
}

const IMPACT_BADGE = { high: '<span class="badge" style="background:var(--danger);color:#fff">High</span>', medium: '<span class="badge" style="background:var(--warn);color:#000">Medium</span>', low: '<span class="badge bb">Low</span>' };

// Returns the worst variance % among active purchases vs WAC, or 0 if none.
function maxPurchaseVariance(ing) {
  const wac = ing.wac || 0;
  if(!wac) return 0;
  return (ing.purchases||[])
    .filter(p => !p.obsolete && p.cpru != null)
    .reduce((max, p) => Math.max(max, Math.abs((p.cpru - wac) / wac)), 0);
}

function renderIngredients() {
  const q = (document.getElementById('ing-search')?.value||'').toLowerCase();
  const impactFilter = document.getElementById('ing-impact-filter')?.value || '';
  let rows = db.ingredients.filter(i => {
    if(q && !i.name.toLowerCase().includes(q) && !(i.category||'').toLowerCase().includes(q)) return false;
    if(impactFilter === 'none') return !i.costImpact;
    if(impactFilter) return i.costImpact === impactFilter;
    return true;
  });
  rows = sortApply(rows, 'ing', (i, col) => ({
    name: i.name, cat: i.category||'', yield: i.yield||100, wac: i.wac||0, eff: effectiveCost(i)
  })[col] ?? i.name);
  applyHdrs('ing', {
    'th-ing-name': ['name','Name'], 'th-ing-cat': ['cat','Category'],
    'th-ing-yield': ['yield','Yield %'], 'th-ing-wac': ['wac','WAC/RU'], 'th-ing-eff': ['eff','Effective Cost/RU']
  });
  const tb = document.getElementById('ing-table');
  if(!rows.length) {
    tb.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:28px">No ingredients.</td></tr>'; return;
  }
  tb.innerHTML = rows.map(i => {
    const eff     = effectiveCost(i);
    const sup     = db.suppliers.find(s => s.id === i.supplierId);
    const maxVar  = maxPurchaseVariance(i);
    const hasWarn = maxVar > 0.20;
    const warnBadge = hasWarn
      ? `<span title="Purchase cost variance ${(maxVar*100).toFixed(1)}% from WAC — review history"
           style="display:inline-block;margin-left:6px;font-size:.72rem;color:var(--warn);cursor:default">⚠ ${(maxVar*100).toFixed(0)}% variance</span>`
      : '';
    return `<tr>
      <td><strong>${i.name}</strong>${i.costImpact ? ` ${IMPACT_BADGE[i.costImpact]||''}` : ''}${warnBadge}${sup ? `<div class="muted">${sup.name}</div>` : ''}</td>
      <td>${i.category ? `<span class="badge bb">${i.category}</span>` : '—'}</td>
      <td><span class="badge ${(i.yield||100)<100?'bw':'bg'}">${i.yield||100}%</span></td>
      <td style="color:var(--accent2)">$${(i.wac||0).toFixed(5)}</td>
      <td style="color:var(--danger)"><strong>$${eff.toFixed(5)}</strong><div class="muted">per 100${i.recipeUnit}: $${(eff*100).toFixed(4)}</div></td>
      <td><span class="badge bb">${i.recipeUnit}</span></td>
      <td>${(i.purchases||[]).filter(p=>!p.obsolete).length} active / ${(i.purchases||[]).length} total</td>
      <td class="flex">
        <button class="btn ${hasWarn ? 'btn-warn' : 'btn-ghost'} btn-sm" onclick="openIngDetail('${i.id}')">History${hasWarn ? ' ⚠' : ''}</button>
        <button class="btn btn-danger btn-sm" onclick="deleteIngredient('${i.id}')">Del</button>
      </td>
    </tr>`;
  }).join('');
}
