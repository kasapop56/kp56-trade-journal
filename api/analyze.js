// api/analyze.js — KP56 Co-pilot analysis endpoint (Phase 3).
//
// One route, three callers:
//   POST /api/analyze  { manual: true }        — dashboard "อ่านให้หน่อย" button.
//                                                 No auth header (user's own page);
//                                                 rate-limited server-side. Forces
//                                                 a fresh Claude read.
//   POST /api/analyze  { force?, trigger_type? } + header X-Agent-Key
//                                               — server-to-server / your routine.
//   GET  /api/analyze                           — scheduler (Vercel cron or your
//                                                 remote routine). Auth via either
//                                                 Authorization: Bearer <CRON_SECRET>
//                                                 or X-Agent-Key. Evaluates triggers;
//                                                 comments only if one fires + not
//                                                 debounced.
//
// Collapsed into a single file (no api/analyze/ folder) to avoid any
// file+directory name collision on the Vercel builder.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY,
//      AGENT_WRITE_KEY, CRON_SECRET (for cron GET),
//      COPILOT_TELEGRAM_* (optional; else TELEGRAM_PLAN_*), COPILOT_MODEL/EFFORT.

const { getDb, runAnalysis, CFG } = require('./_kp_lib');

function bad(res, code, msg) { res.status(code).json({ ok: false, error: msg }); }

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

module.exports = async (req, res) => {
  let force = false;
  let triggerType = null;
  let manual = false;
  let source = 'server';

  if (req.method === 'GET') {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'] || '';
    const agentKey = req.headers['x-agent-key'];
    const cronOk = cronSecret && authHeader === `Bearer ${cronSecret}`;
    const agentOk = process.env.AGENT_WRITE_KEY && agentKey === process.env.AGENT_WRITE_KEY;
    if (!cronOk && !agentOk) return bad(res, 401, 'unauthorized');
    force = String(req.query.force || '') === '1';
    triggerType = req.query.trigger_type || null;
    source = 'cron';
  } else if (req.method === 'POST') {
    let body;
    try { body = await readJson(req); }
    catch (e) { return bad(res, 400, 'invalid_json: ' + e.message); }

    if (body.manual === true) {
      // browser manual read — no key, rate-limited below
      manual = true; force = true; triggerType = 'manual'; source = 'manual';
    } else {
      const expected = process.env.AGENT_WRITE_KEY;
      if (!expected) return bad(res, 500, 'server_missing_agent_write_key');
      if (req.headers['x-agent-key'] !== expected) return bad(res, 401, 'bad_agent_key');
      force = !!body.force;
      triggerType = body.trigger_type || null;
    }
  } else {
    return bad(res, 405, 'method_not_allowed');
  }

  try {
    const db = getDb();

    if (manual) {
      const sinceIso = new Date(Date.now() - CFG.manualRateLimitSec * 1000).toISOString();
      const { data: recent } = await db.from('kp_signals')
        .select('id, ts').eq('trigger_type', 'manual')
        .gte('ts', sinceIso).order('ts', { ascending: false }).limit(1);
      if (recent && recent.length) {
        return res.status(429).json({ ok: false, error: 'rate_limited', retry_after_sec: CFG.manualRateLimitSec, last: recent[0].ts });
      }
    }

    const result = await runAnalysis(db, { force, trigger_type: triggerType, source });
    return res.status(result.ok ? 200 : 500).json(result);
  } catch (e) {
    console.error('analyze error:', e);
    return bad(res, 500, String(e.message || e));
  }
};
