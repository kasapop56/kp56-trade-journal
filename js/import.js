// ── MT5 HTML Report Importer ─────────────────────────────────────────────────
// Parses MT5 "Report" HTML export (History tab → Report → HTML) and inserts
// closed positions into Supabase as trade_ideas + positions rows.

(() => {
  const DATETIME_RE = /^\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}$/;
  let parsedTrades = [];
  let existingKeys = new Set();

  // ── Elements ─────────────────────────────────────────────────────────────
  const modal = document.getElementById('importModal');
  const openBtn = document.getElementById('openImport');
  const closeBtn = document.getElementById('closeImport');
  const dropZone = document.getElementById('importDrop');
  const fileInput = document.getElementById('importFile');
  const symbolInput = document.getElementById('importSymbol');
  const step1 = document.getElementById('importStep1');
  const step2 = document.getElementById('importStep2');
  const previewBody = document.getElementById('previewBody');
  const selectAll = document.getElementById('selectAll');
  const backBtn = document.getElementById('backImport');
  const confirmBtn = document.getElementById('confirmImport');
  const summaryEl = document.getElementById('importSummary');

  // ── Open / close modal ───────────────────────────────────────────────────
  openBtn?.addEventListener('click', async () => {
    parsedTrades = [];
    step1.style.display = '';
    step2.style.display = 'none';
    fileInput.value = '';
    modal.classList.add('open');
    await loadExistingKeys();
  });
  closeBtn.addEventListener('click', () => modal.classList.remove('open'));
  backBtn.addEventListener('click', () => {
    step1.style.display = '';
    step2.style.display = 'none';
  });

  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  selectAll.addEventListener('change', () => {
    previewBody.querySelectorAll('input[type=checkbox]:not(:disabled)').forEach(cb => {
      cb.checked = selectAll.checked;
    });
  });

  // ── File → parse → group → preview ───────────────────────────────────────
  async function handleFile(file) {
    try {
      const text = await file.text();
      const raw = parseMt5Report(text);
      const symbol = symbolInput.value.trim().toUpperCase();
      const filtered = symbol ? raw.filter(t => t.symbol.toUpperCase().includes(symbol)) : raw;
      parsedTrades = groupTrades(filtered);
      renderPreview();
      step1.style.display = 'none';
      step2.style.display = '';
    } catch (err) {
      showToast('Parse failed: ' + err.message, 'error');
    }
  }

  // Group scaled entries: same direction + same closeTime + same symbol → one trade.
  function groupTrades(positions) {
    const map = new Map();
    for (const p of positions) {
      const key = `${p.direction}|${p.closeTime}|${p.symbol}`;
      if (!map.has(key)) {
        map.set(key, {
          symbol: p.symbol,
          direction: p.direction,
          openTime: p.openTime,
          closeTime: p.closeTime,
          closePrice: p.closePrice,
          sl: p.sl,
          tp: p.tp,
          positions: [],
          totalProfit: 0,
          totalSwap: 0,
          totalCommission: 0,
          totalLot: 0,
          positionIds: [],
        });
      }
      const g = map.get(key);
      if (p.openTime < g.openTime) g.openTime = p.openTime; // lex-sortable MT5 format
      g.positions.push({ entry_price: p.openPrice, lot_size: p.volume });
      g.totalProfit += p.profit || 0;
      g.totalSwap += p.swap || 0;
      g.totalCommission += p.commission || 0;
      g.totalLot += p.volume || 0;
      g.positionIds.push(p.positionId);
      if (g.sl == null && p.sl != null) g.sl = p.sl;
      if (g.tp == null && p.tp != null) g.tp = p.tp;
    }
    return [...map.values()].sort((a, b) => a.openTime.localeCompare(b.openTime));
  }

  function parseMt5Report(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = [...doc.querySelectorAll('tr')];
    const trades = [];

    for (const tr of rows) {
      const cells = [...tr.children].map(c => c.textContent.trim());
      if (cells.length < 13) continue;

      // A closed position row has exactly 2 datetime cells (open + close).
      const dtIdx = [];
      cells.forEach((c, i) => { if (DATETIME_RE.test(c)) dtIdx.push(i); });
      if (dtIdx.length !== 2) continue;

      const [openI, closeI] = dtIdx;
      // Layout: [open, posId, symbol, type, vol, openPrice, sl, tp, closeTime, closePrice, comm, swap, profit]
      // Between open (idx) and close (idx+8) are 7 cells: posId, symbol, type, vol, openPrice, sl, tp.
      if (closeI - openI !== 8) continue;

      const type = cells[openI + 3].toLowerCase();
      if (type !== 'buy' && type !== 'sell') continue;

      const row = {
        openTime: cells[openI],
        closeTime: cells[closeI],
        positionId: cells[openI + 1],
        symbol: cells[openI + 2],
        direction: type === 'buy' ? 'BUY' : 'SELL',
        volume: num(cells[openI + 4]),
        openPrice: num(cells[openI + 5]),
        sl: num(cells[openI + 6]),
        tp: num(cells[openI + 7]),
        closePrice: num(cells[closeI + 1]),
        profit: num(cells[cells.length - 1]),
        swap: num(cells[cells.length - 2]) || 0,
        commission: num(cells[cells.length - 3]) || 0,
      };
      if (row.volume == null || row.openPrice == null || row.profit == null) continue;
      trades.push(row);
    }
    return trades;
  }

  function num(s) {
    if (!s) return null;
    const clean = s.replace(/\s/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.');
    const n = parseFloat(clean);
    return isNaN(n) ? null : n;
  }

  // Derive final result tag by comparing close price to SL/TP (gold tolerance 0.5).
  function deriveResult(g) {
    const tol = 0.5;
    if (g.tp && Math.abs(g.closePrice - g.tp) < tol) return 'TP';
    if (g.sl && Math.abs(g.closePrice - g.sl) < tol) return 'SL';
    const net = g.totalProfit + g.totalSwap + g.totalCommission;
    if (Math.abs(net) < 0.5) return 'BE';
    return 'MANUAL';
  }

  // MT5 datetime "2026.04.01 10:23:45" → { date: "2026-04-01", time: "10:23:45" }
  function splitDt(s) {
    const [d, t] = s.split(' ');
    return { date: d.replace(/\./g, '-'), time: t };
  }

  // ── Existing-trade lookup to flag duplicates ─────────────────────────────
  async function loadExistingKeys() {
    existingKeys = new Set();
    const { data } = await db.from('trade_ideas').select('date,entry_time,total_pnl');
    (data || []).forEach(r => {
      existingKeys.add(dupKey(r.date, r.entry_time, r.total_pnl));
    });
  }
  function dupKey(date, time, pnl) {
    const t = time ? time.slice(0, 5) : '';
    const p = pnl != null ? Number(pnl).toFixed(2) : '';
    return `${date}|${t}|${p}`;
  }

  // ── Render preview ───────────────────────────────────────────────────────
  function renderPreview() {
    previewBody.innerHTML = '';
    let dupCount = 0;
    let totalPositions = 0;

    parsedTrades.forEach((g, idx) => {
      totalPositions += g.positions.length;
      const openDt = splitDt(g.openTime);
      const closeDt = splitDt(g.closeTime);
      const netPnl = +(g.totalProfit + g.totalSwap + g.totalCommission).toFixed(2);
      const key = dupKey(openDt.date, openDt.time.slice(0, 5), netPnl);
      const isDup = existingKeys.has(key);
      if (isDup) dupCount++;

      const avgEntry = g.positions.reduce((s, p) => s + p.entry_price * p.lot_size, 0) / (g.totalLot || 1);
      const entryCell = g.positions.length === 1
        ? g.positions[0].entry_price.toFixed(2)
        : `${avgEntry.toFixed(2)}<div class="tiny">avg of ${g.positions.length}</div>`;
      const lotCell = `${g.totalLot.toFixed(2)}${g.positions.length > 1 ? `<div class="tiny">${g.positions.length} pos</div>` : ''}`;

      const tr = document.createElement('tr');
      if (isDup) tr.className = 'dup';
      const pnlClass = netPnl > 0 ? 'pos' : netPnl < 0 ? 'neg' : '';
      tr.innerHTML = `
        <td><input type="checkbox" data-idx="${idx}" ${isDup ? '' : 'checked'} ${isDup ? 'disabled' : ''} /></td>
        <td>${openDt.date}<div class="tiny">${openDt.time.slice(0,5)} → ${closeDt.time.slice(0,5)}</div></td>
        <td>${g.direction}</td>
        <td>${lotCell}</td>
        <td>${entryCell}</td>
        <td>${g.sl ?? '—'}</td>
        <td>${g.tp ?? '—'}</td>
        <td>${g.closePrice}</td>
        <td class="${pnlClass}">${netPnl > 0 ? '+' : ''}${netPnl.toFixed(2)}</td>
        <td>${isDup ? '<span class="tiny">duplicate</span>' : deriveResult(g)}</td>
      `;
      previewBody.appendChild(tr);
    });

    summaryEl.textContent =
      `Found ${parsedTrades.length} trade${parsedTrades.length === 1 ? '' : 's'} ` +
      `from ${totalPositions} MT5 position${totalPositions === 1 ? '' : 's'}` +
      (dupCount ? ` — ${dupCount} already imported (dimmed)` : '');
  }

  // ── Insert selected into Supabase ────────────────────────────────────────
  confirmBtn.addEventListener('click', async () => {
    const checked = [...previewBody.querySelectorAll('input[type=checkbox]:checked')]
      .map(cb => parsedTrades[+cb.dataset.idx]);
    if (!checked.length) {
      showToast('Nothing selected', 'error');
      return;
    }
    confirmBtn.disabled = true;
    confirmBtn.textContent = `Importing 0 / ${checked.length}…`;

    let ok = 0, fail = 0;
    for (let i = 0; i < checked.length; i++) {
      const t = checked[i];
      try {
        await insertTrade(t);
        ok++;
      } catch (err) {
        console.error('import row failed', t, err);
        fail++;
      }
      confirmBtn.textContent = `Importing ${i + 1} / ${checked.length}…`;
    }

    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Import Selected';
    showToast(`Imported ${ok} trade${ok === 1 ? '' : 's'}${fail ? ` (${fail} failed)` : ''}`, fail ? 'error' : 'success');
    if (ok) {
      modal.classList.remove('open');
      loadHistory();
    }
  });

  async function insertTrade(g) {
    const openDt = splitDt(g.openTime);
    const closeDt = splitDt(g.closeTime);
    const netPnl = +(g.totalProfit + g.totalSwap + g.totalCommission).toFixed(2);
    const memoTag = g.positions.length === 1
      ? `Imported from MT5 (position #${g.positionIds[0]})`
      : `Imported from MT5 (${g.positions.length} scaled positions: #${g.positionIds.join(', #')})`;

    const payload = {
      date: openDt.date,
      session: null,
      direction: g.direction,
      bias_h1: null,
      bias_m5: null,
      key_levels: null,
      sl_level: g.sl,
      tp_target: g.tp,
      result: deriveResult(g),
      total_pnl: netPnl,
      max_drawdown: null,
      entry_time: openDt.time,
      exit_time: closeDt.time,
      memo: memoTag,
      post_trade_notes: null,
      screenshots: [],
    };

    const { data: trade, error: err1 } = await db
      .from('trade_ideas').insert(payload).select().single();
    if (err1) throw err1;

    const posRows = g.positions.map(p => ({
      trade_idea_id: trade.id,
      entry_price: p.entry_price,
      lot_size: p.lot_size,
    }));
    const { error: err2 } = await db.from('positions').insert(posRows);
    if (err2) throw err2;
  }
})();
