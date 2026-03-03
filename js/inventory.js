// ── INVENTORY STATE ─────────────────────────────────────────────────────────
let invEditId     = null;  // stock count id being edited (null = new)
let invLines      = [];    // working array for modal lines
let invCurrentSCId = null; // stock count id currently shown in variance view

// ── UNIT CONVERSION ─────────────────────────────────────────────────────────
function convertToRecipeUnits(ing, qty, unit) {
  const ru = ing.recipeUnit; // g, ml, or each
  if (!qty || qty === 0) return 0;

  // Direct match
  if (unit === ru) return qty;

  // Standard weight/volume conversions
  if (unit === 'kg'   && ru === 'g')   return qty * 1000;
  if (unit === 'g'    && ru === 'g')   return qty;
  if (unit === 'L'    && ru === 'ml')  return qty * 1000;
  if (unit === 'ml'   && ru === 'ml')  return qty;
  if (unit === 'lb'   && ru === 'g')   return qty * 453.592;
  if (unit === 'kg'   && ru === 'ml')  return qty * 1000; // water-equivalent liquid
  if (unit === 'L'    && ru === 'g')   return qty * 1000;
  if (unit === 'each' && ru === 'each') return qty;

  // Pack-based units (carton, case, bag, box, dozen, each→g/ml):
  // Find most recent purchase using this buyUnit to derive conversion factor.
  // Each purchase stores baseUnits (total recipe units) and buyQty (purchase units bought).
  const ref = (ing.purchases || [])
    .filter(p => !p.obsolete && p.buyUnit === unit && p.baseUnits > 0 && (p.buyQty || 1) > 0)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  if (ref) {
    const unitsPerBuy = ref.baseUnits / (ref.buyQty || 1);
    return qty * unitsPerBuy;
  }

  return null; // Cannot convert — signals an error
}

// ── THEORETICAL USAGE ────────────────────────────────────────────────────────
// Returns Map<ingredientId, qty in recipe units> based on sales + production batches.
//
// Batch-produced recipes (recipe.batchProduced = true) split into two tiers:
//   1. Raw ingredients consumed by PRODUCTION BATCHES (not sales)
//   2. Finished-goods ingredient consumed by SALES
// Non-batch recipes: raw ingredients consumed directly by sales (unchanged).
function calcTheoreticalUsage(dateFrom, dateTo) {
  const usage = new Map();

  function accumulateLines(lines, factor) {
    (lines || []).forEach(line => {
      if (!line.ref || !line.qty) return;
      const lineQty = (line.qty || 0) * factor;
      if (line.ref.startsWith('ing:')) {
        const ingId = line.ref.slice(4);
        usage.set(ingId, (usage.get(ingId) || 0) + lineQty);
      } else if (line.ref.startsWith('rec:')) {
        const subRec = db.recipes.find(r => r.id === line.ref.slice(4));
        if (subRec) accumulateLines(subRec.lines, lineQty);
      }
    });
  }

  // 1. Sales: for batch recipes consume finished-goods; for regular recipes consume raw ingredients
  const salesInRange = db.sales.filter(s => s.date >= dateFrom && s.date <= dateTo);
  salesInRange.forEach(sale => {
    const menuItem = db.menuItems.find(m => m.id === sale.itemId);
    if (!menuItem) return;

    const recipe = db.recipes.find(r => r.id === menuItem.recipeId);
    if (recipe) {
      if (recipe.batchProduced) {
        // Deduct finished-goods portions (the batch ingredient)
        const batchIng = db.ingredients.find(i => i.batchLinkedRecipeId === recipe.id);
        if (batchIng) {
          usage.set(batchIng.id, (usage.get(batchIng.id) || 0) + sale.qty);
        }
      } else {
        // Regular recipe: deduct raw ingredients from sales
        accumulateLines(recipe.lines, sale.qty);
      }
    }

    // Modifier ingredient usage: always raw ingredients, regardless of batch
    if (sale.modifiers && db.modifierLinks && db.modifierLinks.length) {
      sale.modifiers.split(',').map(s => s.trim()).filter(Boolean).forEach(mod => {
        const link = db.modifierLinks.find(ml => ml.pattern.toLowerCase() === mod.toLowerCase());
        if (!link || !link.ingredientId || !link.qty) return;
        const factor = link.type === 'remove' ? -1 : 1;
        usage.set(link.ingredientId, (usage.get(link.ingredientId) || 0) + link.qty * sale.qty * factor);
      });
    }
  });

  // 2. Production batches: consume raw ingredients of batch recipes
  const batchesInRange = (db.productionBatches || []).filter(pb => pb.date >= dateFrom && pb.date <= dateTo);
  batchesInRange.forEach(pb => {
    const rec = db.recipes.find(r => r.id === pb.recipeId);
    if (!rec) return;
    accumulateLines(rec.lines, pb.portionsProduced);
  });

  return usage;
}

// ── OPENING STOCK (auto-derived from previous count) ─────────────────────────
// Returns opening stock in recipe units for an ingredient in a stock count period.
// Opening stock = closing stock of the most recent previous count that ended before this one.
function getOpeningStock(stockCount, ingredientId) {
  const prevCount = [...(db.stockCounts || [])]
    .filter(sc => sc.id !== stockCount.id && sc.dateTo < stockCount.dateFrom)
    .sort((a, b) => b.dateTo.localeCompare(a.dateTo))[0];
  if (!prevCount) return 0;
  const ing = db.ingredients.find(i => i.id === ingredientId);
  if (!ing) return 0;
  const prevLine = prevCount.lines.find(l => l.ingredientId === ingredientId);
  if (!prevLine) return 0;
  const conv = convertToRecipeUnits(ing, prevLine.closeQty || 0, prevLine.closeUnit);
  return conv !== null ? conv : 0;
}

// ── ACTUAL USAGE ─────────────────────────────────────────────────────────────
// Returns actual usage in recipe units for one ingredient in a stock count period
function calcActualUsage(stockCount, ingredientId) {
  const ing = db.ingredients.find(i => i.id === ingredientId);
  if (!ing) return null;

  const line = stockCount.lines.find(l => l.ingredientId === ingredientId);
  if (!line) return null;

  const openRU  = getOpeningStock(stockCount, ingredientId);
  const closeRU = convertToRecipeUnits(ing, line.closeQty || 0, line.closeUnit);
  if (closeRU === null) return null;

  // Sum purchases recorded in this period (already stored in recipe units as baseUnits)
  const purchasesInPeriod = (ing.purchases || [])
    .filter(p => !p.obsolete && p.date >= stockCount.dateFrom && p.date <= stockCount.dateTo)
    .reduce((sum, p) => sum + (p.baseUnits || 0), 0);

  return openRU + purchasesInPeriod - closeRU;
}

// ── RENDER INVENTORY LIST ────────────────────────────────────────────────────
function renderInventory() {
  db.stockCounts = db.stockCounts || [];
  const tb = document.getElementById('inv-table');
  if (!db.stockCounts.length) {
    tb.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:28px">No stock counts yet. Click "+ New Stock Count" to get started.</td></tr>';
    return;
  }
  tb.innerHTML = [...db.stockCounts]
    .sort((a, b) => b.dateTo.localeCompare(a.dateTo))
    .map(sc => `<tr>
      <td><strong>${sc.dateFrom}</strong> → <strong>${sc.dateTo}</strong></td>
      <td>${sc.lines.length} ingredient${sc.lines.length !== 1 ? 's' : ''}</td>
      <td style="color:var(--muted);font-size:.78rem">${sc.note || '—'}</td>
      <td class="flex">
        <button class="btn btn-ghost btn-sm" onclick="openVarianceView('${sc.id}')">Variance</button>
        <button class="btn btn-ghost btn-sm" onclick="openStockCountModal('${sc.id}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteStockCount('${sc.id}')">Del</button>
      </td>
    </tr>`).join('');
}

// ── VARIANCE VIEW ────────────────────────────────────────────────────────────
function openVarianceView(stockCountId) {
  invCurrentSCId = stockCountId;
  renderVariance(stockCountId);
}

function backToInventoryList() {
  document.getElementById('inv-list-section').style.display     = 'block';
  document.getElementById('inv-variance-section').style.display = 'none';
}

function renderVariance(stockCountId) {
  db.stockCounts = db.stockCounts || [];
  const sc = db.stockCounts.find(x => x.id === stockCountId);
  if (!sc) return;

  const theoretical = calcTheoreticalUsage(sc.dateFrom, sc.dateTo);

  const rows = sc.lines.map(line => {
    const ing      = db.ingredients.find(i => i.id === line.ingredientId);
    const ingName  = ing ? ing.name : '(deleted)';
    const ru       = ing ? ing.recipeUnit : '?';
    const actual   = calcActualUsage(sc, line.ingredientId);
    const theory   = theoretical.get(line.ingredientId) || 0;
    const variance = (actual !== null) ? (actual - theory) : null;

    const openRU   = ing ? getOpeningStock(sc, line.ingredientId) : null;
    const closeRU  = ing ? convertToRecipeUnits(ing, line.closeQty || 0, line.closeUnit) : null;
    const purchInP = ing ? (ing.purchases || [])
      .filter(p => !p.obsolete && p.date >= sc.dateFrom && p.date <= sc.dateTo)
      .reduce((s, p) => s + (p.baseUnits || 0), 0) : 0;

    let varStyle = 'color:var(--muted)';
    if (variance !== null && theory > 0) {
      const pct = Math.abs(variance / theory * 100);
      varStyle = pct > 15 ? 'color:var(--danger)' : pct > 5 ? 'color:var(--warn)' : 'color:var(--accent2)';
    } else if (variance !== null && variance !== 0) {
      varStyle = 'color:var(--warn)';
    }

    const fmtCell = (v, unit) => v !== null ? `${fmt(v)} ${unit}` : `<span style="color:var(--danger)">err</span>`;

    return `<tr>
      <td><strong>${ingName}</strong></td>
      <td>${fmtCell(openRU, ru)}</td>
      <td>${fmt(purchInP)} ${ru}</td>
      <td>${fmtCell(closeRU, ru)}</td>
      <td>${fmtCell(actual, ru)}</td>
      <td>${fmt(theory)} ${ru}</td>
      <td style="${varStyle}"><strong>${variance !== null ? (variance >= 0 ? '+' : '') + fmt(variance) : '—'}</strong></td>
      <td><span class="badge bb">${ru}</span></td>
    </tr>`;
  });

  const el = document.getElementById('inv-variance-table');
  el.innerHTML = rows.length
    ? rows.join('')
    : '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:20px">No lines in this stock count.</td></tr>';

  document.getElementById('inv-variance-period').textContent =
    `${sc.dateFrom} → ${sc.dateTo}${sc.note ? ' — ' + sc.note : ''}`;

  document.getElementById('inv-list-section').style.display     = 'none';
  document.getElementById('inv-variance-section').style.display = 'block';
}

// ── EXPORT CSV ───────────────────────────────────────────────────────────────
function exportVarianceCSV(stockCountId) {
  const sc = db.stockCounts.find(x => x.id === stockCountId);
  if (!sc) return;
  const theoretical = calcTheoreticalUsage(sc.dateFrom, sc.dateTo);
  const rows = [['Ingredient', 'Recipe Unit', 'Open Stock (auto)', 'Purchases In Period', 'Close Stock (counted)', 'Actual Usage', 'Theoretical Usage', 'Variance']];
  sc.lines.forEach(line => {
    const ing = db.ingredients.find(i => i.id === line.ingredientId);
    if (!ing) return;
    const ru      = ing.recipeUnit;
    const openRU  = getOpeningStock(sc, line.ingredientId);
    const closeRU = convertToRecipeUnits(ing, line.closeQty || 0, line.closeUnit) || 0;
    const purchInP = (ing.purchases || [])
      .filter(p => !p.obsolete && p.date >= sc.dateFrom && p.date <= sc.dateTo)
      .reduce((s, p) => s + (p.baseUnits || 0), 0);
    const actual  = openRU + purchInP - closeRU;
    const theory  = theoretical.get(line.ingredientId) || 0;
    rows.push([ing.name, ru, fmt(openRU), fmt(purchInP), fmt(closeRU), fmt(actual), fmt(theory), fmt(actual - theory)]);
  });
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(rows.map(r => r.join(',')).join('\n'));
  a.download = `variance_${sc.dateFrom}_${sc.dateTo}.csv`;
  a.click();
}

// ── CSV TEMPLATE + IMPORT ────────────────────────────────────────────────────
function downloadSCTemplate() {
  const rows = [['Ingredient Name', 'Recipe Unit', 'Count Qty', 'Unit']];
  db.ingredients.forEach(i => {
    const lastPur = [...(i.purchases || [])].filter(p => !p.obsolete).slice(-1)[0];
    const unit = lastPur ? lastPur.buyUnit : i.recipeUnit;
    rows.push([i.name, i.recipeUnit, '', unit]);
  });
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n'));
  a.download = 'stock_count_template.csv';
  a.click();
}

function importSCFromCSV(input) {
  const file = input.files[0]; if (!file) return; input.value = '';
  const reader = new FileReader();
  reader.onload = () => {
    const lines = reader.result.split('\n').map(l => l.trim()).filter(l => l);
    if (lines.length < 2) { toast('CSV has no data rows.', 'error'); return; }
    let added = 0, skipped = 0;
    lines.slice(1).forEach(line => {
      // Parse CSV line — handle quoted fields
      const cols = [];
      let cur = '', inQ = false;
      for (const ch of line + ',') {
        if (ch === '"') { inQ = !inQ; }
        else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
        else { cur += ch; }
      }
      const [ingName, , closeQtyStr, closeUnit] = cols;
      if (!ingName) return;
      const ing = db.ingredients.find(i => i.name.toLowerCase() === ingName.toLowerCase());
      if (!ing) { skipped++; return; }
      if (invLines.find(l => l.ingredientId === ing.id)) { skipped++; return; }
      invLines.push({
        rowId: uid(),
        ingredientId: ing.id,
        closeQty:  parseFloat(closeQtyStr) || 0,
        closeUnit: closeUnit || ing.recipeUnit
      });
      added++;
    });
    renderSCLines();
    toast(`${added} line${added !== 1 ? 's' : ''} imported${skipped ? `, ${skipped} skipped` : ''}.`);
  };
  reader.readAsText(file);
}

// ── STOCK COUNT MODAL ────────────────────────────────────────────────────────
function openStockCountModal(id = null) {
  db.stockCounts = db.stockCounts || [];
  invEditId = id;
  invLines  = [];
  document.getElementById('sc-modal-title').textContent = id ? 'Edit Stock Count' : 'New Stock Count';

  if (id) {
    const sc = db.stockCounts.find(x => x.id === id);
    document.getElementById('sc-from').value = sc.dateFrom;
    document.getElementById('sc-to').value   = sc.dateTo;
    document.getElementById('sc-note').value = sc.note || '';
    invLines = sc.lines.map(l => ({ ...l, rowId: uid() }));
  } else {
    const today = new Date();
    const to    = today.toISOString().slice(0, 10);
    const from  = new Date(today - 7 * 86400000).toISOString().slice(0, 10);
    document.getElementById('sc-from').value = from;
    document.getElementById('sc-to').value   = to;
    document.getElementById('sc-note').value = '';
  }

  renderSCLines();
  openModal('modal-stock-count');
}

// ── RENDER MODAL LINES ───────────────────────────────────────────────────────
function renderSCLines() {
  const el = document.getElementById('sc-lines');
  if (!invLines.length) {
    el.innerHTML = '<div style="padding:10px 0;color:var(--muted);font-size:.84rem">No lines yet — click "+ Add Ingredient" to start.</div>';
    return;
  }

  const ingOpts = '<option value="">— Select ingredient —</option>' +
    db.ingredients
      .filter(i => (i.category || '').toLowerCase() !== 'sundry')
      .map(i => `<option value="${i.id}">${i.name} (${i.recipeUnit})</option>`).join('');

  el.innerHTML = invLines.map((l, idx) => `
    <div style="display:grid;grid-template-columns:2fr 110px 90px auto;gap:6px;align-items:center;
                padding:7px 0;border-bottom:1px solid var(--border)" id="scl-${l.rowId}">
      <select onchange="setSCLine(${idx},'ingredientId',this.value)">${ingOpts}</select>
      <input type="number" step="0.001" min="0" placeholder="Count Qty"
             value="${l.closeQty || ''}"
             oninput="setSCLine(${idx},'closeQty',parseFloat(this.value)||0)">
      <select onchange="setSCLine(${idx},'closeUnit',this.value)">${BUY_UNITS.map(u =>
        `<option${u === (l.closeUnit || 'kg') ? ' selected' : ''}>${u}</option>`).join('')}</select>
      <button class="btn btn-danger btn-sm" onclick="removeSCLine(${idx})">✕</button>
    </div>`).join('');

  // Restore selected ingredient (innerHTML rebuild resets selects)
  invLines.forEach((l, idx) => {
    const row = document.getElementById('scl-' + l.rowId);
    if (row && l.ingredientId) row.querySelector('select').value = l.ingredientId;
  });
}

function setSCLine(idx, key, val) {
  invLines[idx][key] = val;
  if (key === 'ingredientId') {
    // Auto-set unit from ingredient's most recent purchase
    const ing = db.ingredients.find(i => i.id === val);
    const lastPur = ing && [...(ing.purchases || [])].filter(p => !p.obsolete).slice(-1)[0];
    invLines[idx].closeUnit = lastPur ? lastPur.buyUnit : 'kg';
    renderSCLines();
  }
}

function addSCLine() {
  invLines.push({ rowId: uid(), ingredientId: '', closeQty: 0, closeUnit: 'kg' });
  renderSCLines();
}

function removeSCLine(idx) {
  invLines.splice(idx, 1);
  renderSCLines();
}

// ── SAVE / DELETE STOCK COUNT ────────────────────────────────────────────────
function saveStockCount() {
  const dateFrom = document.getElementById('sc-from').value;
  const dateTo   = document.getElementById('sc-to').value;
  if (!dateFrom || !dateTo)  { toast('Date range required.', 'error'); return; }
  if (dateFrom > dateTo)     { toast('Start date must be before end date.', 'error'); return; }

  const lines = invLines
    .filter(l => l.ingredientId)
    .map(l => ({
      ingredientId: l.ingredientId,
      closeQty:  l.closeQty  || 0,
      closeUnit: l.closeUnit || 'kg'
    }));

  const obj = {
    id:       invEditId || uid(),
    dateFrom,
    dateTo,
    note:     document.getElementById('sc-note').value.trim(),
    lines
  };

  if (invEditId) {
    const i = db.stockCounts.findIndex(x => x.id === invEditId);
    db.stockCounts[i] = obj;
  } else {
    db.stockCounts.push(obj);
  }

  saveDB();
  closeModal('modal-stock-count');
  renderInventory();
  toast(invEditId ? 'Stock count updated.' : 'Stock count saved.');
  invEditId = null;
}

function deleteStockCount(id) {
  if (!confirm('Delete this stock count?')) return;
  db.stockCounts = db.stockCounts.filter(x => x.id !== id);
  saveDB();
  renderInventory();
}
