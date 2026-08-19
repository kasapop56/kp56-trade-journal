// Analyze MT5 HTML report and print trading stats.
// Run: node analyze.mjs ReportHistory-87464504.html

import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const path = process.argv[2] || 'ReportHistory-87464504.html';
const buf = fs.readFileSync(path);
let html;
if (buf[0] === 0xFF && buf[1] === 0xFE) {
  html = new TextDecoder('utf-16le').decode(buf.slice(2));
} else if (buf[0] === 0xFE && buf[1] === 0xFF) {
  html = new TextDecoder('utf-16be').decode(buf.slice(2));
} else {
  html = buf.toString('utf8');
}

const dom = new JSDOM(html);
const doc = dom.window.document;

const positions = [];
doc.querySelectorAll('tr').forEach(tr => {
  const visibleTds = [...tr.children]
    .filter(c => c.tagName === 'TD' || c.tagName === 'TH')
    .filter(c => !c.classList.contains('hidden'));
  const cells = visibleTds.map(c => c.textContent.trim());
  // Find direction cell (buy/sell) — anchor
  const dirIdx = cells.findIndex(c => /^(buy|sell)$/i.test(c));
  if (dirIdx < 1) return;
  const openTime = cells[dirIdx - 1];
  if (!/^\d{4}\.\d{2}\.\d{2}\s\d{2}:\d{2}:\d{2}$/.test(openTime)) return;
  // Standard layout: openTime | (ticket) | symbol | direction | volume | entryPrice | sl | tp | closeTime | closePrice | commission | swap | profit
  const direction = cells[dirIdx].toLowerCase();
  const symbol = cells[dirIdx - 2];
  const volume = parseFloat(cells[dirIdx + 1]);
  const entryPrice = parseFloat(cells[dirIdx + 2]);
  const sl = parseFloat(cells[dirIdx + 3]) || null;
  const tp = parseFloat(cells[dirIdx + 4]) || null;
  const closeTime = cells[dirIdx + 5];
  const closePrice = parseFloat(cells[dirIdx + 6]);
  const commission = parseFloat(cells[dirIdx + 7]) || 0;
  const swap = parseFloat(cells[dirIdx + 8]) || 0;
  const profit = parseFloat(cells[dirIdx + 9]) || 0;
  if (!isFinite(volume) || !isFinite(entryPrice) || !isFinite(closePrice)) return;
  if (!/^\d{4}\.\d{2}\.\d{2}\s\d{2}:\d{2}:\d{2}$/.test(closeTime)) return;
  positions.push({
    openTime, closeTime, symbol, direction, volume,
    entryPrice, sl, tp, closePrice, commission, swap, profit,
  });
});

console.log(`Parsed ${positions.length} positions`);

// Group scaled entries: direction + closeTime + symbol
const groups = new Map();
for (const p of positions) {
  const k = `${p.direction}|${p.closeTime}|${p.symbol}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(p);
}

const trades = [...groups.values()].map(ps => {
  ps.sort((a, b) => a.openTime.localeCompare(b.openTime));
  const totalLot = ps.reduce((s, p) => s + p.volume, 0);
  const totalProfit = ps.reduce((s, p) => s + p.profit, 0);
  const totalSwap = ps.reduce((s, p) => s + p.swap, 0);
  const totalComm = ps.reduce((s, p) => s + p.commission, 0);
  const net = totalProfit + totalSwap + totalComm;
  const avgEntry = ps.reduce((s, p) => s + p.entryPrice * p.volume, 0) / totalLot;
  const symbol = ps[0].symbol;
  const direction = ps[0].direction;
  const openTime = ps[0].openTime;
  const closeTime = ps[0].closeTime;
  const sl = ps[0].sl;
  const tp = ps[0].tp;
  const closePrice = ps[0].closePrice;
  // Duration minutes
  const open = new Date(openTime.replace(/\./g, '-').replace(' ', 'T') + 'Z');
  const close = new Date(closeTime.replace(/\./g, '-').replace(' ', 'T') + 'Z');
  const durMin = (close - open) / 60000;
  // Result tag
  const tol = 0.5;
  let result = 'MANUAL';
  if (tp && Math.abs(closePrice - tp) < tol) result = 'TP';
  else if (sl && Math.abs(closePrice - sl) < tol) result = 'SL';
  else if (Math.abs(net) < 0.5) result = 'BE';
  // R multiple if SL exists
  let rMultiple = null;
  if (sl) {
    const risk = Math.abs(avgEntry - sl);
    if (risk > 0) {
      const move = direction === 'buy' ? (closePrice - avgEntry) : (avgEntry - closePrice);
      rMultiple = move / risk;
    }
  }
  return {
    symbol, direction, openTime, closeTime, durMin,
    totalLot, avgEntry, sl, tp, closePrice,
    totalProfit, totalSwap, totalComm, net,
    result, rMultiple, scaled: ps.length > 1, posCount: ps.length,
  };
});

console.log(`Grouped into ${trades.length} trade ideas\n`);

// ── Stats ─────────────────────────────────────────────────────────────
const wins = trades.filter(t => t.net > 0);
const losses = trades.filter(t => t.net < 0);
const flats = trades.filter(t => t.net === 0);
const winRate = wins.length / trades.length * 100;
const totalNet = trades.reduce((s, t) => s + t.net, 0);
const totalComm = trades.reduce((s, t) => s + t.totalComm, 0);
const totalSwap = trades.reduce((s, t) => s + t.totalSwap, 0);
const avgWin = wins.reduce((s, t) => s + t.net, 0) / (wins.length || 1);
const avgLoss = losses.reduce((s, t) => s + t.net, 0) / (losses.length || 1);
const expectancy = totalNet / trades.length;
const profitFactor = Math.abs(wins.reduce((s, t) => s + t.net, 0) / (losses.reduce((s, t) => s + t.net, 0) || 1));
const biggestWin = Math.max(...trades.map(t => t.net));
const biggestLoss = Math.min(...trades.map(t => t.net));

console.log('══════════ OVERALL ══════════');
console.log(`Trades:          ${trades.length}`);
console.log(`Win rate:        ${winRate.toFixed(1)}%  (W:${wins.length} L:${losses.length} BE:${flats.length})`);
console.log(`Net P&L:         $${totalNet.toFixed(2)}`);
console.log(`  Gross profit:  $${wins.reduce((s,t)=>s+t.net,0).toFixed(2)}`);
console.log(`  Gross loss:    $${losses.reduce((s,t)=>s+t.net,0).toFixed(2)}`);
console.log(`  Commission:    $${totalComm.toFixed(2)}`);
console.log(`  Swap:          $${totalSwap.toFixed(2)}`);
console.log(`Avg win:         $${avgWin.toFixed(2)}`);
console.log(`Avg loss:        $${avgLoss.toFixed(2)}`);
console.log(`Win/Loss ratio:  ${Math.abs(avgWin/avgLoss).toFixed(2)}`);
console.log(`Expectancy/td:   $${expectancy.toFixed(2)}`);
console.log(`Profit factor:   ${profitFactor.toFixed(2)}`);
console.log(`Biggest win:     $${biggestWin.toFixed(2)}`);
console.log(`Biggest loss:    $${biggestLoss.toFixed(2)}`);

// Result tag distribution
console.log('\n══════════ RESULT TAGS ══════════');
['TP','SL','BE','MANUAL'].forEach(tag => {
  const g = trades.filter(t => t.result === tag);
  if (!g.length) return;
  const pnl = g.reduce((s,t)=>s+t.net,0);
  const w = g.filter(t=>t.net>0).length;
  console.log(`${tag.padEnd(8)} ${String(g.length).padStart(5)} trades  win% ${((w/g.length)*100).toFixed(1).padStart(5)}  net $${pnl.toFixed(2)}`);
});

// Direction
console.log('\n══════════ DIRECTION ══════════');
['buy','sell'].forEach(d => {
  const g = trades.filter(t => t.direction === d);
  if (!g.length) return;
  const w = g.filter(t=>t.net>0).length;
  const pnl = g.reduce((s,t)=>s+t.net,0);
  console.log(`${d.toUpperCase().padEnd(6)} ${String(g.length).padStart(5)} trades  win% ${((w/g.length)*100).toFixed(1).padStart(5)}  net $${pnl.toFixed(2)}`);
});

// Scaled vs single
console.log('\n══════════ SCALED ENTRIES ══════════');
[{k:'Single',f:t=>!t.scaled},{k:'Scaled',f:t=>t.scaled}].forEach(({k,f})=>{
  const g = trades.filter(f);
  if (!g.length) return;
  const w = g.filter(t=>t.net>0).length;
  const pnl = g.reduce((s,t)=>s+t.net,0);
  console.log(`${k.padEnd(8)} ${String(g.length).padStart(5)} trades  win% ${((w/g.length)*100).toFixed(1).padStart(5)}  net $${pnl.toFixed(2)}`);
});

// By hour of entry (server time; MT5 is broker server time)
console.log('\n══════════ BY HOUR OF ENTRY (broker server time) ══════════');
const byHour = new Map();
for (const t of trades) {
  const h = parseInt(t.openTime.split(' ')[1].split(':')[0], 10);
  if (!byHour.has(h)) byHour.set(h, []);
  byHour.get(h).push(t);
}
[...byHour.keys()].sort((a,b)=>a-b).forEach(h => {
  const g = byHour.get(h);
  const w = g.filter(t=>t.net>0).length;
  const pnl = g.reduce((s,t)=>s+t.net,0);
  console.log(`${String(h).padStart(2,'0')}:00  ${String(g.length).padStart(5)} trades  win% ${((w/g.length)*100).toFixed(1).padStart(5)}  net $${pnl.toFixed(2)}`);
});

// By day of week
console.log('\n══════════ BY DAY OF WEEK ══════════');
const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const byDay = new Map();
for (const t of trades) {
  const d = new Date(t.openTime.replace(/\./g, '-').replace(' ', 'T') + 'Z').getUTCDay();
  if (!byDay.has(d)) byDay.set(d, []);
  byDay.get(d).push(t);
}
[...byDay.keys()].sort((a,b)=>a-b).forEach(d => {
  const g = byDay.get(d);
  const w = g.filter(t=>t.net>0).length;
  const pnl = g.reduce((s,t)=>s+t.net,0);
  console.log(`${dayNames[d]}  ${String(g.length).padStart(5)} trades  win% ${((w/g.length)*100).toFixed(1).padStart(5)}  net $${pnl.toFixed(2)}`);
});

// Duration buckets
console.log('\n══════════ BY HOLD DURATION ══════════');
const bucket = (m) => {
  if (m < 1) return '<1m';
  if (m < 5) return '1-5m';
  if (m < 15) return '5-15m';
  if (m < 60) return '15-60m';
  if (m < 240) return '1-4h';
  if (m < 1440) return '4-24h';
  return '>1d';
};
const durOrder = ['<1m','1-5m','5-15m','15-60m','1-4h','4-24h','>1d'];
const byDur = new Map();
for (const t of trades) {
  const b = bucket(t.durMin);
  if (!byDur.has(b)) byDur.set(b, []);
  byDur.get(b).push(t);
}
durOrder.forEach(b => {
  if (!byDur.has(b)) return;
  const g = byDur.get(b);
  const w = g.filter(t=>t.net>0).length;
  const pnl = g.reduce((s,t)=>s+t.net,0);
  console.log(`${b.padEnd(8)} ${String(g.length).padStart(5)} trades  win% ${((w/g.length)*100).toFixed(1).padStart(5)}  net $${pnl.toFixed(2)}`);
});

// R-multiple distribution (only trades with SL)
const withR = trades.filter(t => t.rMultiple != null && isFinite(t.rMultiple));
if (withR.length) {
  console.log(`\n══════════ R-MULTIPLE (${withR.length} trades with SL) ══════════`);
  const avgR = withR.reduce((s,t)=>s+t.rMultiple,0)/withR.length;
  const rBuckets = [
    ['<-2R', t => t.rMultiple < -2],
    ['-2..-1R', t => t.rMultiple >= -2 && t.rMultiple < -1],
    ['-1..0R', t => t.rMultiple >= -1 && t.rMultiple < 0],
    ['0..1R', t => t.rMultiple >= 0 && t.rMultiple < 1],
    ['1..2R', t => t.rMultiple >= 1 && t.rMultiple < 2],
    ['2..3R', t => t.rMultiple >= 2 && t.rMultiple < 3],
    ['>=3R', t => t.rMultiple >= 3],
  ];
  console.log(`Avg R: ${avgR.toFixed(2)}`);
  rBuckets.forEach(([k,f])=>{
    const g = withR.filter(f);
    if (!g.length) return;
    console.log(`  ${k.padEnd(9)} ${g.length}`);
  });
}

// Monthly breakdown
console.log('\n══════════ BY MONTH ══════════');
const byMonth = new Map();
for (const t of trades) {
  const m = t.openTime.slice(0, 7).replace('.', '-');
  if (!byMonth.has(m)) byMonth.set(m, []);
  byMonth.get(m).push(t);
}
[...byMonth.keys()].sort().forEach(m => {
  const g = byMonth.get(m);
  const w = g.filter(t=>t.net>0).length;
  const pnl = g.reduce((s,t)=>s+t.net,0);
  console.log(`${m}  ${String(g.length).padStart(5)} trades  win% ${((w/g.length)*100).toFixed(1).padStart(5)}  net $${pnl.toFixed(2)}`);
});

// Max consecutive wins/losses
let maxW = 0, maxL = 0, curW = 0, curL = 0;
const sorted = [...trades].sort((a,b)=>a.openTime.localeCompare(b.openTime));
for (const t of sorted) {
  if (t.net > 0) { curW++; curL = 0; maxW = Math.max(maxW, curW); }
  else if (t.net < 0) { curL++; curW = 0; maxL = Math.max(maxL, curL); }
}
console.log(`\nMax consec wins:   ${maxW}`);
console.log(`Max consec losses: ${maxL}`);

// Overtrading check: trades per day
const byDate = new Map();
for (const t of trades) {
  const d = t.openTime.slice(0, 10);
  byDate.set(d, (byDate.get(d) || 0) + 1);
}
const dayCounts = [...byDate.values()];
const avgPerDay = dayCounts.reduce((s,n)=>s+n,0)/dayCounts.length;
const maxPerDay = Math.max(...dayCounts);
const busyDays = [...byDate.entries()].filter(([,n]) => n >= 20).length;
console.log(`\nTrading days:      ${dayCounts.length}`);
console.log(`Avg trades/day:    ${avgPerDay.toFixed(1)}`);
console.log(`Max trades/day:    ${maxPerDay}`);
console.log(`Days with ≥20:     ${busyDays}`);

// Day PnL avg vs trade count (fatigue check)
const dayStats = [...byDate.entries()].map(([d, n]) => {
  const ts = trades.filter(t => t.openTime.startsWith(d));
  const pnl = ts.reduce((s,t)=>s+t.net,0);
  return { d, n, pnl };
});
const lowDays = dayStats.filter(x => x.n < 10);
const medDays = dayStats.filter(x => x.n >= 10 && x.n < 30);
const highDays = dayStats.filter(x => x.n >= 30);
console.log(`\nDays <10 trades:   ${lowDays.length}  avg day PnL $${(lowDays.reduce((s,x)=>s+x.pnl,0)/(lowDays.length||1)).toFixed(2)}`);
console.log(`Days 10-29:        ${medDays.length}  avg day PnL $${(medDays.reduce((s,x)=>s+x.pnl,0)/(medDays.length||1)).toFixed(2)}`);
console.log(`Days ≥30:          ${highDays.length}  avg day PnL $${(highDays.reduce((s,x)=>s+x.pnl,0)/(highDays.length||1)).toFixed(2)}`);
