// ── REPORTS ────────────────────────────────────────────────────────────────
let rptPeriod = 'day';

function setRptPeriod(p, btn) {
  rptPeriod = p;
  document.querySelectorAll('.rpt-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderReports();
}

function getDateRange() {
  const n = new Date(), y = n.getFullYear(),
    m = String(n.getMonth()+1).padStart(2,'0'),
    d = String(n.getDate()).padStart(2,'0');
  if(rptPeriod === 'day')   return { from: `${y}-${m}-${d}`, to: `${y}-${m}-${d}` };
  if(rptPeriod === 'month') return { from: `${y}-${m}-01`,   to: `${y}-${m}-${d}` };
  if(rptPeriod === 'year')  return { from: `${y}-01-01`,     to: `${y}-${m}-${d}` };
  const fi = document.getElementById('rpt-from')?.value;
  const ti = document.getElementById('rpt-to')?.value;
  return { from: fi||`${y}-01-01`, to: ti||`${y}-${m}-${d}` };
}

function renderReports() {
  const di = document.getElementById('rpt-date-inputs');
  if(rptPeriod === 'range') {
    if (!document.getElementById('rpt-from')) {
      const n = todayStr();
      di.innerHTML = `<div class="flex">
        <label style="color:var(--muted);font-size:.78rem;margin:0 4px 0 0">From</label>
        <input type="date" id="rpt-from" value="${n}" onchange="renderReports()" style="width:140px">
        <label style="color:var(--muted);font-size:.78rem;margin:0 4px">To</label>
        <input type="date" id="rpt-to" value="${n}" onchange="renderReports()" style="width:140px">
      </div>`;
    }
  } else {
    di.innerHTML = '';
  }

  const { from, to } = getDateRange();
  const inRange = d => d >= from && d <= to;
  const salesR  = db.sales.filter(s => inRange(s.date));

  let rev = 0, cost = 0;
  salesR.forEach(s => { rev += s.revenue; cost += (s.snapshotCost||0) * s.qty; });
  const profit = rev - cost, pct = rev > 0 ? (cost/rev*100) : 0;

  document.getElementById('rpt-stats').innerHTML = `
    <div class="stat"><div class="stat-val" style="color:var(--accent2)">$${fmt(rev)}</div><div class="stat-label">Revenue</div></div>
    <div class="stat"><div class="stat-val" style="color:var(--danger)">$${fmt(cost)}</div><div class="stat-label">Food Cost</div></div>
    <div class="stat"><div class="stat-val" style="color:var(--accent2)">$${fmt(profit)}</div><div class="stat-label">Gross Profit</div></div>
    <div class="stat"><div class="stat-val" style="color:${pctCol(pct)}">${fmt(pct,1)}%</div><div class="stat-label">Cost %</div></div>`;

  const byItem = {};
  salesR.forEach(s => {
    const m = db.menuItems.find(x => x.id === s.itemId); if(!m) return;
    if(!byItem[m.id]) byItem[m.id] = { name: m.name, qty: 0, rev: 0, cost: 0 };
    byItem[m.id].qty  += s.qty;
    byItem[m.id].rev  += s.revenue;
    byItem[m.id].cost += (s.snapshotCost||0) * s.qty;
  });
  const si = Object.values(byItem).sort((a,b) => b.rev - a.rev);
  document.getElementById('rpt-sales-table').innerHTML = si.length
    ? si.map(i => {
        const p = i.rev > 0 ? (i.cost/i.rev*100) : 0;
        return `<tr><td>${i.name}</td><td>${i.qty}</td><td>$${fmt(i.rev)}</td><td>$${fmt(i.cost)}</td>
          <td><span class="badge ${pctCls(p)}">${fmt(p,1)}%</span></td>
          <td style="color:var(--accent2)">$${fmt(i.rev-i.cost)}</td></tr>`;
      }).join('')
    : '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:16px">No sales in period.</td></tr>';

  const poR = db.importLog.filter(l => l.type === 'invoice' && inRange(l.date));
  document.getElementById('rpt-po-table').innerHTML = poR.length
    ? poR.map(l => `<tr><td>${l.date}</td><td>${l.supplierName||'—'}</td><td>${l.matchedCount??l.itemCount}</td><td>$${fmt(l.totalValue)}</td></tr>`).join('')
    : '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:16px">No POs in period.</td></tr>';

  renderSundryAnalysis();
}

function renderSundryAnalysis() {
  const { from, to } = getDateRange();
  const salesR = db.sales.filter(s => s.date >= from && s.date <= to);

  // Theoretical sundry: group by recipe
  const theoryMap = {};
  let totalTheory = 0;
  salesR.forEach(s => {
    const mi  = db.menuItems.find(m => m.id === s.itemId); if (!mi) return;
    const rec = db.recipes.find(r => r.id === mi.recipeId); if (!rec || !(rec.sundryPct > 0)) return;
    const recipeCost = calcRecipeCost(rec.lines, true);
    const sundryCost = recipeCost * (rec.sundryPct / 100) * s.qty;
    totalTheory += sundryCost;
    if (!theoryMap[rec.id]) theoryMap[rec.id] = { name: rec.name, qty: 0, pct: rec.sundryPct, cost: 0 };
    theoryMap[rec.id].qty  += s.qty;
    theoryMap[rec.id].cost += sundryCost;
  });

  // Actual sundry: purchases of "Sundry" category ingredients in period
  const sundryIngs = (db.ingredients || []).filter(i => (i.category || '').toLowerCase() === 'sundry');
  let totalActual = 0;
  const actualRows = sundryIngs.map(ing => {
    const purs  = (ing.purchases || []).filter(p => !p.obsolete && p.date >= from && p.date <= to);
    const spend = purs.reduce((s, p) => s + (p.totalPrice || 0), 0);
    totalActual += spend;
    return { name: ing.name, count: purs.length, spend };
  }).filter(r => r.count > 0);

  const variance = totalActual - totalTheory;
  const absPct   = totalTheory > 0 ? Math.abs(variance / totalTheory * 100) : null;
  const varCol   = variance === 0 ? 'var(--muted)'
                 : variance > 0   ? 'var(--danger)'
                 :                  'var(--accent2)';
  const hint     = variance > 0 ? '↑ Raise your sundry %'
                 : variance < 0 ? '↓ Lower your sundry %'
                 : '✓ On target';

  document.getElementById('rpt-sundry-stats').innerHTML = `
    <div class="stat"><div class="stat-val" style="color:var(--warn)">$${fmt(totalTheory)}</div><div class="stat-label">Theoretical Sundry</div></div>
    <div class="stat"><div class="stat-val" style="color:var(--danger)">$${fmt(totalActual)}</div><div class="stat-label">Actual Sundry Spend</div></div>
    <div class="stat"><div class="stat-val" style="color:${varCol}">${variance >= 0 ? '+' : ''}$${fmt(variance)}</div>
      <div class="stat-label">Variance${absPct !== null ? ' (' + fmt(absPct,1) + '%)' : ''}</div></div>
    <div class="stat"><div class="stat-val" style="color:${varCol};font-size:.95rem">${hint}</div><div class="stat-label">Calibration</div></div>`;

  const theoryRows = Object.values(theoryMap).sort((a, b) => b.cost - a.cost);
  document.getElementById('rpt-sundry-theory').innerHTML = theoryRows.length
    ? theoryRows.map(r =>
        `<tr><td>${r.name}</td><td>${r.qty}</td>
         <td><span class="badge bw">${fmt(r.pct,1)}%</span></td>
         <td style="color:var(--warn)">$${fmt(r.cost)}</td></tr>`).join('')
    : '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:12px">No recipes with Sundry % set.</td></tr>';

  document.getElementById('rpt-sundry-actual').innerHTML = actualRows.length
    ? actualRows.map(r =>
        `<tr><td>${r.name}</td><td>${r.count}</td>
         <td style="color:var(--danger)">$${fmt(r.spend)}</td></tr>`).join('')
    : '<tr><td colspan="3" style="text-align:center;color:var(--muted);padding:12px">No Sundry purchases in period.<br><span style="font-size:.76rem">Set ingredient category to "Sundry" to track actual spend here.</span></td></tr>';
}
