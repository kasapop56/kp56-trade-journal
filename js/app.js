// ── Supabase config (filled after setup) ──────────────────────────────────────
const SUPABASE_URL = 'https://krnorbptbqticmpocdhc.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtybm9yYnB0YnF0aWNtcG9jZGhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4OTYzNDcsImV4cCI6MjA5MjQ3MjM0N30.dpgf9jmQqGmOwoNPjkaSy2zxM9NJLOdA8RP1dUcCqs0';
const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Navigation ─────────────────────────────────────────────────────────────────
const pages = document.querySelectorAll('.page');
const navLinks = document.querySelectorAll('nav a[data-page]');

function navigate(pageId) {
  pages.forEach(p => p.classList.toggle('active', p.id === pageId));
  navLinks.forEach(a => a.classList.toggle('active', a.dataset.page === pageId));
  if (pageId === 'history') loadHistory();
  if (pageId === 'stats') { allDashboardData = []; loadDashboard(); }
}

navLinks.forEach(a => a.addEventListener('click', e => {
  e.preventDefault();
  navigate(a.dataset.page);
}));

// ── Bias / Result button groups ────────────────────────────────────────────────
function initToggleGroup(selector, dataKey) {
  document.querySelectorAll(selector).forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll(selector).forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      btn.closest('form') ? null : null;
      window.formState = window.formState || {};
      window.formState[dataKey] = btn.dataset.val;
    });
  });
}
initToggleGroup('.bias-btn[data-group="h1"]', 'bias_h1');
initToggleGroup('.bias-btn[data-group="m5"]', 'bias_m5');
initToggleGroup('.result-btn', 'result');

// ── Positions ──────────────────────────────────────────────────────────────────
let positionCount = 1;

function addPositionRow(container, idx) {
  const row = document.createElement('div');
  row.className = 'position-row';
  row.innerHTML = `
    <div>
      ${idx === 1 ? '<label>Entry Price</label>' : ''}
      <input type="number" step="0.01" placeholder="e.g. 4720.50" class="pos-entry" />
    </div>
    <div>
      ${idx === 1 ? '<label>Lot Size</label>' : ''}
      <input type="number" step="0.01" placeholder="e.g. 0.10" class="pos-lot" />
    </div>
    <div>
      ${idx === 1 ? '<label>&nbsp;</label>' : ''}
      <button type="button" class="btn-icon" onclick="this.closest('.position-row').remove()">×</button>
    </div>
  `;
  container.insertBefore(row, container.querySelector('.btn-add'));
}

document.getElementById('addPosition').addEventListener('click', () => {
  positionCount++;
  addPositionRow(document.getElementById('positionsContainer'), positionCount);
});

// ── Screenshots ────────────────────────────────────────────────────────────────
let screenshotFiles = [];

function initDropZone(zoneId, previewId, fileArray) {
  const zone = document.getElementById(zoneId);
  const preview = document.getElementById(previewId);
  const input = zone.querySelector('input[type="file"]');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    handleFiles([...e.dataTransfer.files], preview, fileArray);
  });
  input.addEventListener('change', () => handleFiles([...input.files], preview, fileArray));

  // Paste support
  document.addEventListener('paste', e => {
    const items = [...e.clipboardData.items];
    const imgs = items.filter(i => i.type.startsWith('image'));
    if (imgs.length) handleFiles(imgs.map(i => i.getAsFile()), preview, fileArray);
  });
}

function handleFiles(files, preview, fileArray) {
  files.forEach(file => {
    if (!file || !file.type.startsWith('image')) return;
    fileArray.push(file);
    const url = URL.createObjectURL(file);
    const wrap = document.createElement('div');
    wrap.className = 'img-wrap';
    const idx = fileArray.length - 1;
    wrap.innerHTML = `
      <img src="${url}" onclick="openImg('${url}')" />
      <button class="img-remove" onclick="removeScreenshot(${idx}, this.closest('.img-wrap'))">×</button>
    `;
    preview.appendChild(wrap);
  });
}

function removeScreenshot(idx, el) {
  screenshotFiles[idx] = null;
  el.remove();
}

window.openImg = url => window.open(url, '_blank');

initDropZone('dropZone', 'screenshotPreview', screenshotFiles);

// ── Form Submit ────────────────────────────────────────────────────────────────
let editingTradeId = null;
let existingScreenshots = [];

document.getElementById('tradeForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.textContent = editingTradeId ? 'Updating...' : 'Saving...';

  try {
    const formState = window.formState || {};
    const date = document.getElementById('tradeDate').value;
    const session = document.getElementById('session').value;
    const sl = document.getElementById('slLevel').value;
    const tp = document.getElementById('tpTarget').value;
    const pnl = document.getElementById('totalPnl').value;
    const drawdown = document.getElementById('maxDrawdown').value;
    const keyLevels = document.getElementById('keyLevels').value;
    const memo = document.getElementById('memo').value;
    const postNotes = document.getElementById('postNotes').value;

    // Upload new screenshots
    const newUrls = [];
    const validFiles = screenshotFiles.filter(Boolean);
    for (const file of validFiles) {
      const filename = `${Date.now()}_${file.name}`;
      const { error } = await db.storage.from('screenshots').upload(filename, file);
      if (!error) {
        const { data } = db.storage.from('screenshots').getPublicUrl(filename);
        newUrls.push(data.publicUrl);
      }
    }
    const screenshotUrls = [...existingScreenshots, ...newUrls];

    const payload = {
      date, session,
      bias_h1: formState.bias_h1 || null,
      bias_m5: formState.bias_m5 || null,
      key_levels: keyLevels,
      sl_level: sl ? parseFloat(sl) : null,
      tp_target: tp ? parseFloat(tp) : null,
      result: formState.result || null,
      total_pnl: pnl ? parseFloat(pnl) : null,
      max_drawdown: drawdown ? parseFloat(drawdown) : null,
      memo, post_trade_notes: postNotes,
      screenshots: screenshotUrls
    };

    let tradeId;
    if (editingTradeId) {
      const { error } = await db.from('trade_ideas').update(payload).eq('id', editingTradeId);
      if (error) throw error;
      tradeId = editingTradeId;
      // Replace positions
      await db.from('positions').delete().eq('trade_idea_id', tradeId);
    } else {
      const { data: trade, error: tradeErr } = await db.from('trade_ideas').insert(payload).select().single();
      if (tradeErr) throw tradeErr;
      tradeId = trade.id;
    }

    // Insert positions
    const posRows = document.querySelectorAll('.position-row');
    const positions = [];
    posRows.forEach(row => {
      const entry = row.querySelector('.pos-entry')?.value;
      const lot = row.querySelector('.pos-lot')?.value;
      if (entry && lot) positions.push({ trade_idea_id: tradeId, entry_price: parseFloat(entry), lot_size: parseFloat(lot) });
    });
    if (positions.length) await db.from('positions').insert(positions);

    showToast(editingTradeId ? 'Trade updated!' : 'Trade saved!', 'success');
    resetForm();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Trade';
  }
});

function resetForm() {
  document.getElementById('tradeForm').reset();
  window.formState = {};
  editingTradeId = null;
  existingScreenshots = [];
  document.querySelectorAll('.bias-btn, .result-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('screenshotPreview').innerHTML = '';
  screenshotFiles.length = 0;
  document.querySelectorAll('.position-row').forEach((r, i) => { if (i > 0) r.remove(); });
  document.querySelector('.pos-entry').value = '';
  document.querySelector('.pos-lot').value = '';
  document.getElementById('submitBtn').textContent = 'Save Trade';
  document.getElementById('tradeDate').value = new Date().toISOString().split('T')[0];
}

function loadTradeIntoForm(t) {
  resetForm();
  editingTradeId = t.id;
  existingScreenshots = t.screenshots || [];

  document.getElementById('tradeDate').value = t.date || '';
  document.getElementById('session').value = t.session || '';
  document.getElementById('keyLevels').value = t.key_levels || '';
  document.getElementById('slLevel').value = t.sl_level || '';
  document.getElementById('tpTarget').value = t.tp_target || '';
  document.getElementById('totalPnl').value = t.total_pnl || '';
  document.getElementById('maxDrawdown').value = t.max_drawdown || '';
  document.getElementById('memo').value = t.memo || '';
  document.getElementById('postNotes').value = t.post_trade_notes || '';

  // Bias buttons
  window.formState = { bias_h1: t.bias_h1, bias_m5: t.bias_m5, result: t.result };
  if (t.bias_h1) document.querySelector(`.bias-btn[data-group="h1"][data-val="${t.bias_h1}"]`)?.classList.add('selected');
  if (t.bias_m5) document.querySelector(`.bias-btn[data-group="m5"][data-val="${t.bias_m5}"]`)?.classList.add('selected');
  if (t.result) document.querySelector(`.result-btn[data-val="${t.result}"]`)?.classList.add('selected');

  // Positions
  const container = document.getElementById('positionsContainer');
  document.querySelectorAll('.position-row').forEach((r, i) => { if (i > 0) r.remove(); });
  const firstEntry = container.querySelector('.pos-entry');
  const firstLot = container.querySelector('.pos-lot');
  if (t.positions?.length) {
    firstEntry.value = t.positions[0].entry_price || '';
    firstLot.value = t.positions[0].lot_size || '';
    for (let i = 1; i < t.positions.length; i++) {
      positionCount++;
      addPositionRow(container, positionCount);
      const rows = container.querySelectorAll('.position-row');
      rows[i].querySelector('.pos-entry').value = t.positions[i].entry_price || '';
      rows[i].querySelector('.pos-lot').value = t.positions[i].lot_size || '';
    }
  }

  // Show existing screenshots
  const preview = document.getElementById('screenshotPreview');
  existingScreenshots.forEach((url, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'img-wrap';
    wrap.innerHTML = `
      <img src="${url}" onclick="openImg('${url}')" />
      <button class="img-remove" onclick="existingScreenshots.splice(${i},1);this.closest('.img-wrap').remove()">×</button>
    `;
    preview.appendChild(wrap);
  });

  document.getElementById('submitBtn').textContent = 'Update Trade';
  navigate('new');
}

// ── History ────────────────────────────────────────────────────────────────────
async function loadHistory() {
  const container = document.getElementById('historyList');
  container.innerHTML = '<p class="empty">Loading...</p>';

  const { data, error } = await db
    .from('trade_ideas')
    .select('*, positions(*)')
    .order('date', { ascending: false });

  if (error || !data?.length) {
    container.innerHTML = '<p class="empty">No trades yet. Start logging!</p>';
    return;
  }

  container.innerHTML = '';
  data.forEach(t => {
    const pnlClass = t.total_pnl > 0 ? 'pos' : t.total_pnl < 0 ? 'neg' : '';
    const pnlText = t.total_pnl != null ? (t.total_pnl > 0 ? '+' : '') + t.total_pnl.toFixed(2) : '—';
    const card = document.createElement('div');
    card.className = 'trade-card';
    card.innerHTML = `
      <div class="header">
        <span class="date">${t.date} &nbsp;|&nbsp; ${t.session || '—'}</span>
        <span class="pnl ${pnlClass}">${pnlText}</span>
      </div>
      <div class="tags">
        ${t.bias_h1 ? `<span class="tag ${t.bias_h1.toLowerCase()}">H1 ${t.bias_h1}</span>` : ''}
        ${t.bias_m5 ? `<span class="tag ${t.bias_m5.toLowerCase()}">M5 ${t.bias_m5}</span>` : ''}
        ${t.result ? `<span class="tag ${t.result.toLowerCase()}">${t.result}</span>` : ''}
        ${t.session ? `<span class="tag session">${t.session}</span>` : ''}
        ${t.positions?.length ? `<span class="tag session">${t.positions.length} position${t.positions.length > 1 ? 's' : ''}</span>` : ''}
      </div>
    `;
    card.addEventListener('click', () => openTradeModal(t));
    container.appendChild(card);
  });
}

// ── Trade Modal ────────────────────────────────────────────────────────────────
function openTradeModal(t) {
  document.getElementById('modalDate').textContent = `${t.date} — ${t.session || ''}`;
  document.getElementById('modalBias').textContent = `H1: ${t.bias_h1 || '—'} | M5: ${t.bias_m5 || '—'}`;
  document.getElementById('modalLevels').textContent = `SL: ${t.sl_level || '—'} | TP: ${t.tp_target || '—'} | Key: ${t.key_levels || '—'}`;
  document.getElementById('modalResult').textContent = `${t.result || '—'} | P&L: ${t.total_pnl != null ? t.total_pnl : '—'}`;
  document.getElementById('modalDrawdown').textContent = t.max_drawdown != null ? `Max Drawdown: -${t.max_drawdown}` : '';
  document.getElementById('modalMemo').textContent = t.memo || '—';
  document.getElementById('modalPostNotes').textContent = t.post_trade_notes || '—';

  // Positions
  const posDiv = document.getElementById('modalPositions');
  if (t.positions?.length) {
    posDiv.innerHTML = t.positions.map(p =>
      `<div style="font-size:13px;margin-bottom:4px;">Entry: <b>${p.entry_price}</b> | Lot: <b>${p.lot_size}</b></div>`
    ).join('');
  } else {
    posDiv.textContent = '—';
  }

  // Screenshots
  const imgDiv = document.getElementById('modalImgs');
  imgDiv.innerHTML = '';
  if (t.screenshots?.length) {
    t.screenshots.forEach(url => {
      const img = document.createElement('img');
      img.src = url;
      img.onclick = () => window.open(url, '_blank');
      imgDiv.appendChild(img);
    });
  }

  document.getElementById('tradeModal').classList.add('open');
  document.getElementById('editModal').onclick = () => {
    document.getElementById('tradeModal').classList.remove('open');
    loadTradeIntoForm(t);
  };
  document.getElementById('deleteModal').onclick = async () => {
    if (!confirm('Delete this trade? This cannot be undone.')) return;
    await db.from('positions').delete().eq('trade_idea_id', t.id);
    await db.from('trade_ideas').delete().eq('id', t.id);
    document.getElementById('tradeModal').classList.remove('open');
    showToast('Trade deleted', 'error');
    loadHistory();
  };
}

document.getElementById('closeModal').addEventListener('click', () => {
  document.getElementById('tradeModal').classList.remove('open');
});


// ── Toast ──────────────────────────────────────────────────────────────────────
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ── Init ───────────────────────────────────────────────────────────────────────
document.getElementById('tradeDate').value = new Date().toISOString().split('T')[0];
navigate('new');
