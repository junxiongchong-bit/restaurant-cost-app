// ── SALES ──────────────────────────────────────────────────────────────────
function openSalesModal() {
  const sel = document.getElementById('sales-item');
  sel.innerHTML = '<option value="">— Select —</option>' +
    db.menuItems.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
  document.getElementById('sales-date').value = todayStr();
  ['sales-qty','sales-rev'].forEach(x => document.getElementById(x).value = '');
  document.getElementById('sales-preview').style.display = 'none';
  openModal('modal-sales');
}

function updateSalesPreview() {
  const itemId = document.getElementById('sales-item').value;
  const qty    = parseInt(document.getElementById('sales-qty').value)||0;
  const el     = document.getElementById('sales-preview');
  if(!itemId || !qty) { el.style.display = 'none'; return; }
  const m   = db.menuItems.find(x => x.id === itemId);
  const rec = db.recipes.find(r => r.id === m?.recipeId);
  const uc  = rec ? calcRecipeCost(rec.lines, true) : 0;
  const rev = parseFloat(document.getElementById('sales-rev').value) || m.price * qty;
  const tc  = uc * qty, pct = rev > 0 ? (tc/rev*100) : 0;
  el.style.display = 'block';
  el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
    <div><div class="muted">Revenue</div><strong>$${fmt(rev)}</strong></div>
    <div><div class="muted">Cost (yield-adj snap)</div><strong>$${fmt(tc)}</strong></div>
    <div><div class="muted">Cost %</div><strong style="color:${pctCol(pct)}">${fmt(pct,1)}%</strong></div>
    <div><div class="muted">Profit</div><strong style="color:var(--accent2)">$${fmt(rev-tc)}</strong></div>
  </div>`;
}

function saveSale() {
  const itemId = document.getElementById('sales-item').value;
  const qty    = parseInt(document.getElementById('sales-qty').value);
  const date   = document.getElementById('sales-date').value;
  if(!itemId || !qty || !date) { toast('Fill all fields.', 'error'); return; }
  const m    = db.menuItems.find(x => x.id === itemId);
  const rec  = db.recipes.find(r => r.id === m.recipeId);
  const snap = rec ? calcRecipeCost(rec.lines, true) : 0;
  const rev  = parseFloat(document.getElementById('sales-rev').value) || m.price * qty;
  db.sales.push({ id: uid(), date, itemId, qty, revenue: rev, snapshotCost: snap });
  saveDB(); closeModal('modal-sales'); renderSales(); toast('Sale recorded.');
}

function deleteSale(id) {
  db.sales = db.sales.filter(x => x.id !== id);
  saveDB(); renderSales();
}

function renderSales() {
  const tb = document.getElementById('sales-table');
  if(!db.sales.length) {
    tb.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:28px">No sales.</td></tr>'; return;
  }
  tb.innerHTML = [...db.sales].sort((a,b) => b.date.localeCompare(a.date)).map(s => {
    const m   = db.menuItems.find(x => x.id === s.itemId);
    const tc  = (s.snapshotCost||0) * s.qty;
    const pct = s.revenue > 0 ? (tc/s.revenue*100) : 0;
    return `<tr>
      <td>${s.date}</td><td>${m?.name||'—'}</td><td>${s.qty}</td><td>$${fmt(s.revenue)}</td>
      <td>$${fmt(tc)}<div class="muted">@$${fmt(s.snapshotCost,5)}/unit</div></td>
      <td><span class="badge ${pctCls(pct)}">${fmt(pct,1)}%</span></td>
      <td style="color:var(--accent2)">$${fmt(s.revenue-tc)}</td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteSale('${s.id}')">Del</button></td>
    </tr>`;
  }).join('');
}

function exportSalesCSV() {
  const rows = [['Date','Item','Qty','Revenue','Food Cost','Cost %','Gross Profit']];
  db.sales.forEach(s => {
    const m   = db.menuItems.find(x => x.id === s.itemId);
    const tc  = (s.snapshotCost||0) * s.qty;
    const pct = s.revenue > 0 ? (tc/s.revenue*100).toFixed(1) : '0';
    rows.push([s.date, m?.name||'?', s.qty, fmt(s.revenue), fmt(tc), pct+'%', fmt(s.revenue-tc)]);
  });
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(rows.map(r => r.join(',')).join('\n'));
  a.download = 'sales_' + todayStr() + '.csv';
  a.click();
}
