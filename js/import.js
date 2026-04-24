// ── MT5 HTML Report Importer ─────────────────────────────────────────────────
// Parses MT5 "Report" HTML export (History tab → Report → HTML) and upserts
// each closed position into mt5_trades. Used to backfill gaps when the VPS
// running the JournalSync EA is offline. Dedup is by position_id.

(() => {
  // Account that imported trades belong to. The HF Markets live account the
  // EA syncs; imports from the same account fill gaps in that stream.
  const IMPORT_ACCOUNT_LOGIN = 87464504;
  const DATETIME_RE = /^\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}(?::\d{2})?$/;
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
      const text = await readFileSmart(file);
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

  // Group scaled entries for the preview (same direction + same closeTime +
  // same symbol → one row). Each group keeps refs to its underlying parsed
  // positions so the confirm step can insert one mt5_trades row per position.
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
          rawPositions: [],
          totalProfit: 0,
          totalSwap: 0,
          totalCommission: 0,
          totalLot: 0,
          positionIds: [],
        });
      }
      const g = map.get(key);
      if (p.openTime < g.openTime) g.openTime = p.openTime; // lex-sortable MT5 format
      g.rawPositions.push(p);
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

  // MT5 exports HTML as UTF-16 LE (with BOM). Blob.text() assumes UTF-8, which
  // produces garbage. Detect BOM and decode with the right encoding.
  async function readFileSmart(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let encoding = 'utf-8';
    let offset = 0;
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      encoding = 'utf-16le'; offset = 2;
    } else if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      encoding = 'utf-16be'; offset = 2;
    } else if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      offset = 3; // UTF-8 BOM
    }
    return new TextDecoder(encoding).decode(bytes.slice(offset));
  }

  function parseMt5Report(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = [...doc.querySelectorAll('tr')];
    const trades = [];
    const diag = { totalRows: rows.length, twoDt: 0, noType: 0, missingVals: 0, samples: [] };

    for (const tr of rows) {
      // HF Markets reports inject <td class="hidden" colspan="8"> spacer cells.
      // Strip those before indexing so the layout matches the header row.
      const visibleTds = [...tr.children].filter(c =>
        c.tagName === 'TD' || c.tagName === 'TH'
      ).filter(c => !c.classList.contains('hidden'));
      const cells = visibleTds.map(c =>
        c.textContent.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim()
      );
      if (cells.length < 10) continue;

      const dtIdx = [];
      cells.forEach((c, i) => { if (DATETIME_RE.test(c)) dtIdx.push(i); });
      if (dtIdx.length < 2) continue;
      diag.twoDt++;

      const [openI, closeI] = dtIdx;

      // Anchor on the type cell (buy/sell) between the two datetime cells.
      // Standard MT5 Positions layout (13 cols):
      //   Time | PositionID | Symbol | Type | Volume | Price | S/L | T/P | Time(close) | Price(close) | Commission | Swap | Profit
      // Relative to typeI: -2 = posId, -1 = symbol, +1 = volume, +2 = openPrice, +3 = sl, +4 = tp.
      let typeI = -1;
      for (let i = openI + 1; i < closeI; i++) {
        const t = cells[i].toLowerCase();
        if (t === 'buy' || t === 'sell') { typeI = i; break; }
      }
      if (typeI < 0) {
        diag.noType++;
        if (diag.samples.length < 3) diag.samples.push({ reason: 'no buy/sell between DTs', cells });
        continue;
      }

      const row = {
        openTime: cells[openI],
        closeTime: cells[closeI],
        positionId: typeI - 2 >= openI ? cells[typeI - 2] : '',
        symbol: typeI - 1 > openI ? cells[typeI - 1] : '',
        direction: cells[typeI].toLowerCase() === 'buy' ? 'BUY' : 'SELL',
        volume: num(cells[typeI + 1]),
        openPrice: num(cells[typeI + 2]),
        sl: num(cells[typeI + 3]),
        tp: num(cells[typeI + 4]),
        closePrice: num(cells[closeI + 1]),
        profit: num(cells[cells.length - 1]),
        swap: num(cells[cells.length - 2]) || 0,
        commission: num(cells[cells.length - 3]) || 0,
      };
      if (row.volume == null || row.openPrice == null || row.profit == null) {
        diag.missingVals++;
        if (diag.samples.length < 3) diag.samples.push({ reason: 'missing volume/openPrice/profit', row, cells });
        continue;
      }
      trades.push(row);
    }

    console.log('[MT5 importer]', {
      totalRows: diag.totalRows,
      rowsWith2DT: diag.twoDt,
      rejectedNoType: diag.noType,
      rejectedMissingValues: diag.missingVals,
      parsed: trades.length,
      samples: diag.samples,
    });
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
  // We dedup on position_id. The EA ingest uses the close deal_ticket as the
  // unique key, but the HTML report doesn't expose it — position_id is the
  // only identifier shared between the two sources.
  async function loadExistingKeys() {
    existingKeys = new Set();
    const data = await fetchAllPaged('mt5_trades', q =>
      q.select('position_id')
    );
    data.forEach(r => {
      if (r.position_id != null) existingKeys.add(String(r.position_id));
    });
  }

  // Convert MT5 HTML datetime "2026.04.01 10:23:45" (broker server time,
  // GMT+getServerTzOffset()) to UTC ISO8601 so it matches what the EA writes.
  function mt5DtToUtcIso(s) {
    const [d, t] = s.split(' ');
    const [Y, M, D] = d.split('.').map(Number);
    const [h, m, sec = 0] = (t || '00:00:00').split(':').map(Number);
    const offset = getServerTzOffset();
    const utc = new Date(Date.UTC(Y, M - 1, D, h - offset, m, sec));
    return utc.toISOString().replace(/\.\d+Z$/, 'Z');
  }

  // ── Render preview ───────────────────────────────────────────────────────
  function renderPreview() {
    previewBody.innerHTML = '';
    let dupCount = 0;
    let totalPositions = 0;

    parsedTrades.forEach((g, idx) => {
      totalPositions += g.rawPositions.length;
      const openDt = splitDt(g.openTime);
      const closeDt = splitDt(g.closeTime);
      const netPnl = +(g.totalProfit + g.totalSwap + g.totalCommission).toFixed(2);
      // Group = duplicate only if every underlying position is already in DB.
      // Mixed groups stay selectable; upsert silently skips the known ones.
      const isDup = g.positionIds.length > 0 &&
                    g.positionIds.every(pid => existingKeys.has(String(pid)));
      if (isDup) dupCount++;

      const avgEntry = g.rawPositions.reduce(
        (s, p) => s + p.openPrice * p.volume, 0) / (g.totalLot || 1);
      const entryCell = g.rawPositions.length === 1
        ? g.rawPositions[0].openPrice.toFixed(2)
        : `${avgEntry.toFixed(2)}<div class="tiny">avg of ${g.rawPositions.length}</div>`;
      const lotCell = `${g.totalLot.toFixed(2)}${g.rawPositions.length > 1 ? `<div class="tiny">${g.rawPositions.length} pos</div>` : ''}`;

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
    // One mt5_trades row per underlying MT5 position. Upsert on deal_ticket
    // (which we set to position_id, since the HTML report has no deal ticket
    // — see file-top comment). ignoreDuplicates=true makes re-importing a
    // partially-synced report a no-op for already-present rows.
    const type = g.direction.toLowerCase();
    const rows = g.rawPositions.map(p => ({
      account_login: IMPORT_ACCOUNT_LOGIN,
      deal_ticket:   Number(p.positionId),
      position_id:   Number(p.positionId),
      symbol:        p.symbol,
      type,
      volume:        p.volume,
      open_time:     mt5DtToUtcIso(p.openTime),
      close_time:    mt5DtToUtcIso(p.closeTime),
      open_price:    p.openPrice,
      close_price:   p.closePrice,
      sl:            p.sl,
      tp:            p.tp,
      profit:        p.profit ?? 0,
      swap:          p.swap ?? 0,
      commission:    p.commission ?? 0,
      comment:       'Imported from MT5 HTML report',
    }));

    const { error } = await db
      .from('mt5_trades')
      .upsert(rows, { onConflict: 'deal_ticket', ignoreDuplicates: true });
    if (error) throw error;
  }
})();
