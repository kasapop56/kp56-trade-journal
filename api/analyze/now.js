// api/analyze/now.js — KP56 Co-pilot manual read (Phase 3).
//
// POST /api/analyze/now — called by the dashboard "🔍 อ่านให้หน่อย" button.
// No auth header (it's the user's own dashboard), but rate-limited server-side
// to cap Claude cost: at most one manual read per CFG.manualRateLimitSec.
// Always forces a fresh Claude read regardless of triggers.
//
// Env vars: same as api/analyze.js (needs ANTHROPIC_API_KEY + Supabase +
// optionally Telegram).

const { getDb, runAnalysis, CFG } = require('../_kp_lib');

function bad(res, code, msg) { res.status(code).json({ ok: false, error: msg }); }

module.exports = async (req, res) => {
  if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed');

  try {
    const db = getDb();

    // rate limit: reject if a manual read happened within the window
    const sinceIso = new Date(Date.now() - CFG.manualRateLimitSec * 1000).toISOString();
    const { data: recent } = await db.from('kp_signals')
      .select('id, ts').eq('trigger_type', 'manual')
      .gte('ts', sinceIso).order('ts', { ascending: false }).limit(1);
    if (recent && recent.length) {
      return res.status(429).json({ ok: false, error: 'rate_limited', retry_after_sec: CFG.manualRateLimitSec, last: recent[0].ts });
    }

    const result = await runAnalysis(db, { force: true, trigger_type: 'manual', source: 'manual' });
    return res.status(result.ok ? 200 : 500).json(result);
  } catch (e) {
    console.error('analyze/now error:', e);
    return bad(res, 500, String(e.message || e));
  }
};
