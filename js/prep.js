// ── KITCHEN PREP CHECKLIST ──────────────────────────────────────────────────
let prepEditId = null;
let prepActiveTab = 'checklist';

function switchPrepTab(tab, btn) {
  prepActiveTab = tab;
  document.getElementById('prep-tab-checklist').style.display = tab === 'checklist' ? '' : 'none';
  document.getElementById('prep-tab-yield').style.display     = tab === 'yield'      ? '' : 'none';
  document.getElementById('prep-reset-btn').style.display     = tab === 'checklist'  ? '' : 'none';
  document.getElementById('prep-add-btn').style.display       = tab === 'checklist'  ? '' : 'none';
  document.getElementById('yield-add-btn').style.display      = tab === 'yield'      ? '' : 'none';
  document.getElementById('yield-fetch-btn').style.display    = tab === 'yield'      ? '' : 'none';
  document.querySelectorAll('#page-prep .tab-btn').forEach(b => b.classList.toggle('active', b === btn));
  if (tab === 'yield') renderYieldLog();
  else renderPrep();
}

const PREP_CATS = ['Slice','Cook','Prep','Mix','Portion','Wash & Portion','Precook'];

const PREP_DEFAULTS = [
  // Slice
  { category:'Slice', name:'Mushroom' },
  { category:'Slice', name:'Onion' },
  { category:'Slice', name:'Hams' },
  { category:'Slice', name:'Salami' },
  { category:'Slice', name:'Calabrese' },
  { category:'Slice', name:'Capsicum' },
  { category:'Slice', name:'Chicken' },
  { category:'Slice', name:'Zucchini' },
  { category:'Slice', name:'Cherry Tomato' },
  { category:'Slice', name:'Bacon' },
  // Cook
  { category:'Cook', name:'Sausages (crush)' },
  { category:'Cook', name:'Prawns' },
  { category:'Cook', name:'Chips' },
  // Prep
  { category:'Prep', name:'Olive' },
  { category:'Prep', name:'Pineapple' },
  { category:'Prep', name:'Anchovies' },
  // Mix
  { category:'Mix', name:'Mozzarella Cheese' },
  { category:'Mix', name:'Tomato Sauce' },
  { category:'Mix', name:'Spicy Mayo' },
  { category:'Mix', name:'Truffle Mayo' },
  { category:'Mix', name:'Italian Chili Oil' },
  { category:'Mix', name:'BBQ Sauce' },
  { category:'Mix', name:'Pesto Sauce' },
  // Portion
  { category:'Portion', name:'Seafood Mix' },
  { category:'Portion', name:'Burrata Cheese' },
  { category:'Portion', name:'Straciatella' },
  // Wash & Portion
  { category:'Wash & Portion', name:'Mussels' },
  // Precook
  { category:'Precook', name:'Penne' },
  { category:'Precook', name:'Spaghetti' },
  { category:'Precook', name:'Gluten Free Penne' },
  { category:'Precook', name:'Tagliatelle' },
];

function seedPrepDefaults() {
  if (db.prepTasks.length > 0) return;
  PREP_DEFAULTS.forEach((t, i) => {
    db.prepTasks.push({ id: uid(), category: t.category, name: t.name, targetQty: '', order: i });
  });
  saveDB();
}

function getTodayChecks() {
  return db.prepDailyHistory?.[todayStr()]?.checks || {};
}

function saveTodayChecks(checks) {
  if (!db.prepDailyHistory) db.prepDailyHistory = {};
  db.prepDailyHistory[todayStr()] = { checks };
  saveDB();
}

// ── RENDER ──────────────────────────────────────────────────────────────────
function renderPrep() {
  seedPrepDefaults();

  const checks = getTodayChecks();
  const total = db.prepTasks.length;
  const done = db.prepTasks.filter(t => checks[t.id]?.done).length;
  const pct = total ? Math.round(done / total * 100) : 0;

  // Overall progress bar
  document.getElementById('prep-progress-bar').innerHTML = `
    <div style="display:flex;align-items:center;gap:12px">
      <div class="pbar" style="flex:1;height:10px">
        <div class="pfill" style="width:${pct}%;background:${pct===100?'var(--accent2)':'var(--accent)'}"></div>
      </div>
      <span style="font-size:.85rem;color:var(--muted);white-space:nowrap">${done} / ${total} done</span>
    </div>`;

  // Group tasks by category (preserve PREP_CATS order)
  const grouped = {};
  PREP_CATS.forEach(c => grouped[c] = []);
  db.prepTasks.forEach(t => {
    if (!grouped[t.category]) grouped[t.category] = [];
    grouped[t.category].push(t);
  });

  // Collect any custom categories not in PREP_CATS
  db.prepTasks.forEach(t => {
    if (!PREP_CATS.includes(t.category)) {
      if (!grouped[t.category]) grouped[t.category] = [];
    }
  });

  const catContainer = document.getElementById('prep-categories');
  const cats = [...PREP_CATS, ...Object.keys(grouped).filter(c => !PREP_CATS.includes(c))];

  catContainer.innerHTML = cats.map(cat => {
    const tasks = grouped[cat] || [];
    if (tasks.length === 0) return '';

    const catDone = tasks.filter(t => checks[t.id]?.done).length;
    const catPct = tasks.length ? Math.round(catDone / tasks.length * 100) : 0;

    const rows = tasks
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(t => {
        const c = checks[t.id] || {};
        const isDone = !!c.done;
        return `
        <tr style="${isDone ? 'background:rgba(78,204,163,.07)' : ''}">
          <td style="width:32px;padding:8px 6px 8px 14px">
            <input type="checkbox" ${isDone ? 'checked' : ''}
              onchange="togglePrepTask('${t.id}')"
              style="width:16px;height:16px;cursor:pointer;accent-color:var(--accent2)">
          </td>
          <td style="font-size:.88rem;${isDone ? 'color:var(--muted);text-decoration:line-through' : ''}">
            ${t.name}
            ${t.instruction ? `<div style="font-size:.75rem;color:var(--muted);margin-top:2px;font-style:italic;text-decoration:none">${t.instruction}</div>` : ''}
          </td>
          <td style="color:var(--muted);font-size:.78rem;width:100px">${t.targetQty || ''}</td>
          <td style="width:130px;padding:6px 8px">
            <input type="text" value="${c.actualQty || ''}"
              placeholder="actual qty"
              ${isDone ? '' : 'disabled'}
              style="width:100%;padding:4px 8px;font-size:.78rem;${!isDone ? 'opacity:.35' : ''}"
              onchange="setPrepActualQty('${t.id}', this.value)"
              title="Actual quantity done">
          </td>
          <td style="width:64px;text-align:right;padding-right:10px">
            <button class="btn btn-ghost btn-sm" onclick="openPrepTaskModal('${t.id}')" style="padding:2px 7px;font-size:.72rem">✏</button>
            <button class="btn btn-danger btn-sm" onclick="deletePrepTask('${t.id}')" style="padding:2px 7px;font-size:.72rem">✕</button>
          </td>
        </tr>`;
      }).join('');

    return `
    <div class="card" style="padding:0;overflow:hidden;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--surface2);border-bottom:1px solid var(--border)">
        <span style="font-weight:600;font-size:.88rem;text-transform:uppercase;letter-spacing:.04em">${cat}</span>
        <div class="pbar" style="flex:1;height:5px">
          <div class="pfill" style="width:${catPct}%;background:${catPct===100?'var(--accent2)':'var(--accent)'}"></div>
        </div>
        <span class="muted" style="font-size:.75rem;white-space:nowrap">${catDone}/${tasks.length}</span>
      </div>
      <table style="margin:0">
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');
}

// ── ACTIONS ─────────────────────────────────────────────────────────────────
function togglePrepTask(taskId) {
  const checks = { ...getTodayChecks() };
  const cur = checks[taskId] || {};
  checks[taskId] = { ...cur, done: !cur.done };
  saveTodayChecks(checks);
  renderPrep();
}

function setPrepActualQty(taskId, val) {
  const checks = { ...getTodayChecks() };
  checks[taskId] = { ...( checks[taskId] || {} ), actualQty: val };
  saveTodayChecks(checks);
}

function resetPrepDay() {
  if (!confirm('Reset all prep tasks for today? This will clear all checkmarks and actual quantities.')) return;
  if (!db.prepDailyHistory) db.prepDailyHistory = {};
  delete db.prepDailyHistory[todayStr()];
  saveDB();
  renderPrep();
  toast('Prep list reset for today.');
}

// ── MODAL ────────────────────────────────────────────────────────────────────
function openPrepTaskModal(id = null) {
  prepEditId = id;
  document.getElementById('prep-task-modal-title').textContent = id ? 'Edit Task' : 'Add Prep Task';

  // Populate category select
  const sel = document.getElementById('prep-task-cat');
  const allCats = [...new Set([...PREP_CATS, ...db.prepTasks.map(t => t.category)])];
  sel.innerHTML = allCats.map(c => `<option>${c}</option>`).join('') +
    '<option value="__new__">+ New category…</option>';

  if (id) {
    const t = db.prepTasks.find(x => x.id === id);
    document.getElementById('prep-task-name').value = t.name;
    sel.value = t.category;
    document.getElementById('prep-task-qty').value = t.targetQty || '';
    document.getElementById('prep-task-instruction').value = t.instruction || '';
    document.getElementById('prep-task-newcat').style.display = 'none';
    document.getElementById('prep-task-newcat').value = '';
  } else {
    document.getElementById('prep-task-name').value = '';
    sel.value = PREP_CATS[0];
    document.getElementById('prep-task-qty').value = '';
    document.getElementById('prep-task-instruction').value = '';
    document.getElementById('prep-task-newcat').style.display = 'none';
    document.getElementById('prep-task-newcat').value = '';
  }

  openModal('modal-prep-task');
}

function onPrepCatChange() {
  const sel = document.getElementById('prep-task-cat');
  const newCatInput = document.getElementById('prep-task-newcat');
  if (sel.value === '__new__') {
    newCatInput.style.display = '';
    newCatInput.focus();
  } else {
    newCatInput.style.display = 'none';
  }
}

function savePrepTask() {
  const name = document.getElementById('prep-task-name').value.trim();
  if (!name) { toast('Task name required.', 'error'); return; }

  let cat = document.getElementById('prep-task-cat').value;
  if (cat === '__new__') {
    cat = document.getElementById('prep-task-newcat').value.trim();
    if (!cat) { toast('Category name required.', 'error'); return; }
  }

  const targetQty   = document.getElementById('prep-task-qty').value.trim();
  const instruction = document.getElementById('prep-task-instruction').value.trim();

  if (prepEditId) {
    const i = db.prepTasks.findIndex(x => x.id === prepEditId);
    db.prepTasks[i] = { ...db.prepTasks[i], name, category: cat, targetQty, instruction };
  } else {
    const maxOrder = db.prepTasks.reduce((m, t) => Math.max(m, t.order ?? 0), -1);
    db.prepTasks.push({ id: uid(), category: cat, name, targetQty, instruction, order: maxOrder + 1 });
  }

  saveDB();
  closeModal('modal-prep-task');
  renderPrep();
  toast(prepEditId ? 'Task updated.' : 'Task added.');
  prepEditId = null;
}

function deletePrepTask(id) {
  const t = db.prepTasks.find(x => x.id === id);
  if (!confirm(`Delete "${t?.name}"?`)) return;
  db.prepTasks = db.prepTasks.filter(x => x.id !== id);
  // Clean up daily checks
  if (db.prepDaily?.checks) delete db.prepDaily.checks[id];
  saveDB();
  renderPrep();
  toast('Task deleted.');
}

// ── YIELD LOG ────────────────────────────────────────────────────────────────
let yieldEditId = null;

const WEIGHT_FACTORS = { g: 1, kg: 1000, lb: 453.592, oz: 28.3495 };
function toGrams(qty, unit) { return qty * (WEIGHT_FACTORS[unit] || 1); }

function renderYieldLog() {
  db.yieldLogs = db.yieldLogs || [];

  // Build per-ingredient yield summaries
  const byIng = {};
  db.yieldLogs.forEach(log => {
    const inputG  = toGrams(log.inputQty,  log.inputUnit);
    const outputG = toGrams(log.outputQty, log.outputUnit);
    const yPct    = inputG > 0 ? (outputG / inputG * 100) : 0;
    if (!byIng[log.ingredientId]) byIng[log.ingredientId] = [];
    byIng[log.ingredientId].push(yPct);
  });

  const ingIds = Object.keys(byIng);
  let summaryHtml = '';
  if (ingIds.length) {
    const rows = ingIds.map(ingId => {
      const ing    = db.ingredients.find(i => i.id === ingId);
      const yields = byIng[ingId];
      const avg    = yields.reduce((a, b) => a + b, 0) / yields.length;
      const min    = Math.min(...yields);
      const max    = Math.max(...yields);
      const col    = avg >= 80 ? 'var(--accent2)' : avg >= 60 ? 'var(--warn)' : 'var(--danger)';
      const applyBtn = ing
        ? `<button class="btn btn-sm btn-success" onclick="applyYieldToIngredient('${ingId}',${avg.toFixed(4)})">Apply Avg</button>`
        : '';
      return `<tr>
        <td>${ing ? ing.name : '<span style="color:var(--danger)">(deleted)</span>'}</td>
        <td style="color:var(--muted)">${yields.length}</td>
        <td style="color:var(--muted)">${min.toFixed(1)}%</td>
        <td style="color:var(--muted)">${max.toFixed(1)}%</td>
        <td><strong style="color:${col}">${avg.toFixed(1)}%</strong></td>
        <td style="color:var(--muted)">${ing ? ing.yield + '%' : '—'}</td>
        <td>${applyBtn}</td>
      </tr>`;
    }).join('');
    summaryHtml = `
      <div class="card" style="margin-bottom:16px">
        <div class="muted" style="font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">Yield Summary by Ingredient</div>
        <table>
          <thead><tr>
            <th>Ingredient</th><th>Logs</th><th>Min</th><th>Max</th><th>Avg Yield</th><th>Current Yield</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="muted" style="margin-top:8px;font-size:.75rem">"Apply Avg" updates the ingredient's yield % — this affects effective cost in all recipes.</div>
      </div>`;
  }
  document.getElementById('yield-summary').innerHTML = summaryHtml;

  // Full log table
  const sorted = [...db.yieldLogs].sort((a, b) => b.date.localeCompare(a.date));
  document.getElementById('yield-table').innerHTML = sorted.length
    ? sorted.map(log => {
        const ing     = db.ingredients.find(i => i.id === log.ingredientId);
        const inputG  = toGrams(log.inputQty,  log.inputUnit);
        const outputG = toGrams(log.outputQty, log.outputUnit);
        const yPct    = inputG > 0 ? (outputG / inputG * 100) : 0;
        const col     = yPct >= 80 ? 'var(--accent2)' : yPct >= 60 ? 'var(--warn)' : 'var(--danger)';
        return `<tr>
          <td>${log.date}</td>
          <td>${ing ? ing.name : '<span style="color:var(--danger)">(deleted)</span>'}</td>
          <td>${log.inputQty} ${log.inputUnit}</td>
          <td>${log.outputQty} ${log.outputUnit}</td>
          <td><strong style="color:${col}">${yPct.toFixed(1)}%</strong></td>
          <td style="color:var(--muted)">${log.note || '—'}</td>
          <td class="flex">
            <button class="btn btn-ghost btn-sm" onclick="openYieldModal('${log.id}')">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteYieldLog('${log.id}')">Del</button>
          </td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:28px">No yield logs yet. Click "+ Log Yield" to record your first prep measurement.</td></tr>';
}

function openYieldModal(id = null) {
  yieldEditId = id;
  document.getElementById('yield-modal-title').textContent = id ? 'Edit Yield Log' : 'Log Yield';

  // Populate ingredient select (exclude auto-managed batch ingredients)
  const ings = (db.ingredients || []).filter(i => !i.batchLinkedRecipeId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const sel = document.getElementById('yield-ingredient');
  sel.innerHTML = '<option value="">— Select ingredient —</option>' +
    ings.map(i => `<option value="${i.id}">${i.name}</option>`).join('');

  if (id) {
    const log = (db.yieldLogs || []).find(x => x.id === id);
    if (log) {
      document.getElementById('yield-date').value        = log.date;
      sel.value                                           = log.ingredientId;
      document.getElementById('yield-input-qty').value   = log.inputQty;
      document.getElementById('yield-input-unit').value  = log.inputUnit;
      document.getElementById('yield-output-qty').value  = log.outputQty;
      document.getElementById('yield-output-unit').value = log.outputUnit;
      document.getElementById('yield-note').value        = log.note || '';
    }
  } else {
    document.getElementById('yield-date').value        = todayStr();
    sel.value                                           = '';
    document.getElementById('yield-input-qty').value   = '';
    document.getElementById('yield-input-unit').value  = 'kg';
    document.getElementById('yield-output-qty').value  = '';
    document.getElementById('yield-output-unit').value = 'kg';
    document.getElementById('yield-note').value        = '';
  }

  updateYieldPreview();
  openModal('modal-yield-log');
}

function updateYieldPreview() {
  const inputQty  = parseFloat(document.getElementById('yield-input-qty').value)  || 0;
  const inputUnit = document.getElementById('yield-input-unit').value;
  const outputQty = parseFloat(document.getElementById('yield-output-qty').value) || 0;
  const outputUnit= document.getElementById('yield-output-unit').value;
  const el        = document.getElementById('yield-preview');

  if (!inputQty || !outputQty) { el.innerHTML = ''; return; }

  const inputG  = toGrams(inputQty,  inputUnit);
  const outputG = toGrams(outputQty, outputUnit);
  const yPct    = inputG > 0 ? (outputG / inputG * 100) : 0;
  const wasteG  = inputG - outputG;
  const col     = yPct >= 80 ? 'var(--accent2)' : yPct >= 60 ? 'var(--warn)' : 'var(--danger)';

  el.innerHTML = `<div class="cb" style="margin-top:10px;display:flex;gap:20px;flex-wrap:wrap">
    <span>Yield: <strong style="color:${col}">${yPct.toFixed(1)}%</strong></span>
    <span>Waste: <strong style="color:var(--muted)">${(100 - yPct).toFixed(1)}%</strong>
      <span class="muted">(${wasteG >= 1000 ? (wasteG/1000).toFixed(3)+' kg' : wasteG.toFixed(0)+' g'})</span>
    </span>
  </div>`;
}

function saveYieldLog() {
  const ingredientId = document.getElementById('yield-ingredient').value;
  const date         = document.getElementById('yield-date').value;
  const inputQty     = parseFloat(document.getElementById('yield-input-qty').value);
  const inputUnit    = document.getElementById('yield-input-unit').value;
  const outputQty    = parseFloat(document.getElementById('yield-output-qty').value);
  const outputUnit   = document.getElementById('yield-output-unit').value;
  const note         = document.getElementById('yield-note').value.trim();

  if (!ingredientId)          { toast('Select an ingredient.',        'error'); return; }
  if (!date)                  { toast('Date required.',               'error'); return; }
  if (!inputQty || inputQty <= 0)  { toast('Input weight must be > 0.',  'error'); return; }
  if (!outputQty || outputQty <= 0){ toast('Output weight must be > 0.', 'error'); return; }

  const inputG  = toGrams(inputQty,  inputUnit);
  const outputG = toGrams(outputQty, outputUnit);
  if (outputG > inputG + 0.001) { toast('Output weight cannot exceed input weight.', 'error'); return; }

  const entry = { id: yieldEditId || uid(), date, ingredientId, inputQty, inputUnit, outputQty, outputUnit, note };

  db.yieldLogs = db.yieldLogs || [];
  if (yieldEditId) {
    const idx = db.yieldLogs.findIndex(x => x.id === yieldEditId);
    db.yieldLogs[idx] = entry;
  } else {
    db.yieldLogs.push(entry);
  }

  saveDB();
  closeModal('modal-yield-log');
  renderYieldLog();
  const yPct = (outputG / inputG * 100).toFixed(1);
  toast(`Yield logged: ${yPct}% — ${outputQty} ${outputUnit} from ${inputQty} ${inputUnit}.`);
  yieldEditId = null;
}

function deleteYieldLog(id) {
  if (!confirm('Delete this yield log entry?')) return;
  db.yieldLogs = (db.yieldLogs || []).filter(x => x.id !== id);
  saveDB();
  renderYieldLog();
  toast('Yield log deleted.');
}

function applyYieldToIngredient(ingId, avgYield) {
  const ing = db.ingredients.find(i => i.id === ingId);
  if (!ing) return;
  const rounded = Math.round(avgYield * 10) / 10;
  if (!confirm(`Apply ${rounded}% yield to "${ing.name}"?\n\nThis updates the ingredient's yield percentage from ${ing.yield}% to ${rounded}%, which will change its effective cost in all recipes.`)) return;
  ing.yield = rounded;
  saveDB();
  renderYieldLog();
  toast(`"${ing.name}" yield updated to ${rounded}%.`);
}

async function fetchYieldLogsFromFirebase() {
  const url = (localStorage.getItem('rcc-fb-db-url') || '').replace(/\/$/, '');
  if (!url) { toast('No Firebase URL set in Settings.', 'error'); return; }

  const btn = document.getElementById('yield-fetch-btn');
  btn.disabled = true;
  btn.textContent = 'Fetching…';

  try {
    const res = await fetch(url + '/rcc/pendingYieldLogs.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const raw = await res.json();

    if (!raw) { toast('No yield logs found in Firebase.'); return; }

    // Firebase POST returns an object keyed by push-IDs
    const entries = (Array.isArray(raw) ? raw : Object.values(raw)).filter(Boolean);

    // Group by taskId+date, pick latest entry per group (latest id = latest timestamp)
    // Entries without taskId are treated individually (e.g. future manual entries)
    const groups = {};
    const noTaskEntries = [];
    entries.forEach(e => {
      if (!e.taskId) { noTaskEntries.push(e); return; }
      const key = e.taskId + '|' + e.date;
      if (!groups[key]) groups[key] = [];
      groups[key].push(e);
    });

    // For each group, take the latest entry only
    const resolved = [];
    Object.values(groups).forEach(group => {
      const latest = group.sort((a, b) => (b.id || '').localeCompare(a.id || ''))[0];
      if (!latest.cleared) resolved.push(latest);
      // if latest is cleared, the whole group is void — skip all
    });
    // No-taskId entries: include if not cleared
    noTaskEntries.forEach(e => { if (!e.cleared) resolved.push(e); });

    db.yieldLogs = db.yieldLogs || [];
    const existingIds = new Set(db.yieldLogs.map(x => x.id));

    let imported = 0;
    let skipped = 0;

    resolved.forEach(e => {
      if (existingIds.has(e.id)) { skipped++; return; }

      // Resolve ingredientId: use e.ingredientId if valid, else match by name
      let ingId = e.ingredientId;
      if (!ingId || !db.ingredients.find(i => i.id === ingId)) {
        const byName = (db.ingredients || []).find(i =>
          i.name.toLowerCase() === (e.ingredientName || '').toLowerCase()
        );
        ingId = byName ? byName.id : null;
      }

      if (!ingId) { skipped++; return; } // can't match ingredient — skip

      db.yieldLogs.push({
        id:           e.id,
        date:         e.date,
        ingredientId: ingId,
        inputQty:     e.inputQty,
        inputUnit:    e.inputUnit,
        outputQty:    e.outputQty,
        outputUnit:   e.outputUnit,
        note:         e.note || '',
      });
      existingIds.add(e.id);
      imported++;
    });

    saveDB();
    renderYieldLog();
    toast(`Fetched ${imported} new yield log${imported !== 1 ? 's' : ''} from Firebase.${skipped ? ` (${skipped} skipped)` : ''}`);
  } catch(e) {
    toast('Fetch failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '⬇ Fetch Firebase';
  }
}
