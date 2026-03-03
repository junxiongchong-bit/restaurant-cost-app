// ── PRODUCTION BATCHES ───────────────────────────────────────────────────────
// Batch production log: records when batch recipes are made in bulk.
// Each batch logs raw ingredient consumption and updates the WAC of the
// corresponding finished-goods ingredient (e.g. "Tiramisu [batch]").
//
// Flow:
//   Recipe (batchProduced: true) → Production Batch → Finished-goods Ingredient
//   Finished-goods Ingredient → Stock Counts (count remaining portions)
//   Finished-goods Ingredient is consumed by Sales via calcTheoreticalUsage()
// ─────────────────────────────────────────────────────────────────────────────

let prodEditId = null;

// ── BATCH INGREDIENT HELPER ──────────────────────────────────────────────────
// Returns the auto-managed finished-goods ingredient for a batch recipe.
// Creates it if it doesn't exist yet.
function getOrCreateBatchIngredient(recipeId) {
  const rec = db.recipes.find(r => r.id === recipeId);
  if (!rec) return null;

  // Find existing
  let ing = db.ingredients.find(i => i.batchLinkedRecipeId === recipeId);
  if (!ing) {
    // Create a finished-goods ingredient (unit = each, yield = 100)
    ing = {
      id:                  uid(),
      name:                rec.name + ' [batch]',
      category:            'Batch',
      recipeUnit:          'each',
      yield:               100,
      wac:                 0,
      totalBaseUnits:      0,
      purchases:           [],
      batchLinkedRecipeId: recipeId
    };
    db.ingredients.push(ing);
  }
  return ing;
}

// ── RENDER ───────────────────────────────────────────────────────────────────
function renderProduction() {
  db.productionBatches = db.productionBatches || [];
  const tb = document.getElementById('prod-table');
  if (!tb) return;

  if (!db.productionBatches.length) {
    tb.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:28px">' +
      'No batches yet. Mark a recipe as "Batch production" in Recipes, then click "+ Log Batch".</td></tr>';
    return;
  }

  const sorted = [...db.productionBatches].sort((a, b) => b.date.localeCompare(a.date));
  tb.innerHTML = sorted.map(pb => {
    const rec          = db.recipes.find(r => r.id === pb.recipeId);
    const rawCostTotal = rec ? calcRecipeCost(rec.lines, true) * pb.portionsProduced : 0;
    const cpPortion    = pb.portionsProduced > 0 ? rawCostTotal / pb.portionsProduced : 0;
    return `<tr>
      <td>${pb.date}</td>
      <td><strong>${rec ? rec.name : '<span style="color:var(--danger)">(recipe deleted)</span>'}</strong></td>
      <td>${pb.portionsProduced}</td>
      <td>$${fmt(rawCostTotal)} <span class="muted" style="font-size:.76rem">($${fmt(cpPortion)}/each)</span></td>
      <td style="color:var(--muted);font-size:.78rem">${pb.note || '—'}</td>
      <td class="flex">
        <button class="btn btn-ghost btn-sm" onclick="openProductionModal('${pb.id}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteProductionBatch('${pb.id}')">Del</button>
      </td>
    </tr>`;
  }).join('');
}

// ── MODAL ────────────────────────────────────────────────────────────────────
function openProductionModal(id = null) {
  prodEditId = id;
  document.getElementById('prod-modal-title').textContent = id ? 'Edit Production Batch' : 'Log Production Batch';

  // Only show batch-enabled recipes
  const batchRecs = (db.recipes || []).filter(r => r.batchProduced);
  const sel = document.getElementById('prod-recipe');
  sel.innerHTML = '<option value="">— Select batch recipe —</option>' +
    batchRecs.map(r => `<option value="${r.id}">${r.name}</option>`).join('');

  if (!batchRecs.length) {
    sel.innerHTML = '<option value="">No batch recipes — mark a recipe as Batch first</option>';
  }

  if (id) {
    const pb = (db.productionBatches || []).find(x => x.id === id);
    if (pb) {
      document.getElementById('prod-date').value = pb.date;
      sel.value = pb.recipeId;
      document.getElementById('prod-qty').value  = pb.portionsProduced;
      document.getElementById('prod-note').value = pb.note || '';
      updateProductionPreview();
    }
  } else {
    document.getElementById('prod-date').value = todayStr();
    document.getElementById('prod-qty').value  = '';
    document.getElementById('prod-note').value = '';
    document.getElementById('prod-preview').innerHTML = '';
  }

  openModal('modal-production');
}

function updateProductionPreview() {
  const recipeId = document.getElementById('prod-recipe').value;
  const qty      = parseFloat(document.getElementById('prod-qty').value) || 0;
  const el       = document.getElementById('prod-preview');

  if (!recipeId || !qty) { el.innerHTML = ''; return; }
  const rec = db.recipes.find(r => r.id === recipeId);
  if (!rec) { el.innerHTML = ''; return; }

  const rawCostTotal = calcRecipeCost(rec.lines, true) * qty;
  const cpPortion    = qty > 0 ? rawCostTotal / qty : 0;
  el.innerHTML = `<div class="cb" style="margin-top:10px">
    Batch cost: <strong style="color:var(--danger)">$${fmt(rawCostTotal)}</strong>
    &nbsp;|&nbsp;
    WAC per portion: <strong style="color:var(--accent2)">$${fmt(cpPortion)}</strong>
    &nbsp;·&nbsp;
    <span class="muted" style="font-size:.78rem">Updates "${rec.name} [batch]" ingredient WAC</span>
  </div>`;
}

// ── SAVE ─────────────────────────────────────────────────────────────────────
function saveProductionBatch() {
  const recipeId = document.getElementById('prod-recipe').value;
  const qty      = parseFloat(document.getElementById('prod-qty').value) || 0;
  const date     = document.getElementById('prod-date').value;
  const note     = document.getElementById('prod-note').value.trim();

  if (!recipeId)    { toast('Select a batch recipe.', 'error'); return; }
  if (!qty || qty <= 0) { toast('Portions must be > 0.', 'error'); return; }
  if (!date)        { toast('Date required.', 'error'); return; }

  const batchId = prodEditId || uid();

  // If editing, remove the old batch's WAC contribution first
  if (prodEditId) {
    const old = (db.productionBatches || []).find(x => x.id === prodEditId);
    if (old) {
      const oldIng = db.ingredients.find(i => i.batchLinkedRecipeId === old.recipeId);
      if (oldIng) {
        oldIng.purchases = (oldIng.purchases || []).filter(p => p.batchId !== prodEditId);
        recalcWAC(oldIng);
      }
    }
    db.productionBatches = (db.productionBatches || []).filter(x => x.id !== prodEditId);
  }

  // Compute batch cost from current ingredient WAC
  const rec          = db.recipes.find(r => r.id === recipeId);
  const rawCostTotal = rec ? calcRecipeCost(rec.lines, true) * qty : 0;
  const cpPortion    = qty > 0 ? rawCostTotal / qty : 0;

  // Update the finished-goods ingredient: add a "purchase" record so WAC is recalculated
  const batchIng = getOrCreateBatchIngredient(recipeId);
  if (batchIng) {
    batchIng.purchases.push({
      id:         uid(),
      batchId,           // back-link so we can remove it if batch is edited/deleted
      date,
      buyUnit:    'batch',
      buyQty:     1,
      baseUnits:  qty,
      totalPrice: rawCostTotal,
      cpru:       cpPortion,
      obsolete:   false
    });
    recalcWAC(batchIng);
  }

  db.productionBatches = db.productionBatches || [];
  db.productionBatches.push({ id: batchId, date, recipeId, portionsProduced: qty, note });

  saveDB();
  closeModal('modal-production');
  renderProduction();
  toast(`Batch logged — ${qty} portions of "${rec ? rec.name : ''}", WAC $${fmt(cpPortion)}/each.`);
  prodEditId = null;
}

// ── DELETE ────────────────────────────────────────────────────────────────────
function deleteProductionBatch(id) {
  if (!confirm('Delete this batch? Its WAC contribution will be removed from the finished-goods ingredient.')) return;

  const pb = (db.productionBatches || []).find(x => x.id === id);
  if (pb) {
    const batchIng = db.ingredients.find(i => i.batchLinkedRecipeId === pb.recipeId);
    if (batchIng) {
      batchIng.purchases = (batchIng.purchases || []).filter(p => p.batchId !== id);
      recalcWAC(batchIng);
    }
  }

  db.productionBatches = (db.productionBatches || []).filter(x => x.id !== id);
  saveDB();
  renderProduction();
  toast('Batch deleted.');
}
