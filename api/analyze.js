// api/analyze.js — KP56 Co-pilot trigger engine entry (Phase 3).
//
// Two callers:
//   GET  /api/analyze         — Vercel Cron. Auth: Authorization: Bearer <CRON_SECRET>
//                               (Vercel sets this automatically when CRON_SECRET
//                               is configured). Evaluates triggers; comments only
//                               if one fires and isn't debounced.
//   POST /api/analyze         — server-to-server. Auth: X-Agent-Key: <AGENT_WRITE_KEY>
//                               Body: { force?:bool, trigger_type?:string }
//
// The heavy Claude call happens only when a trigger actually fires, so quiet
// ticks return fast. Cron cadence is set in vercel.json.
//
// Env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ANTHROPIC_API_KEY
//   CRON_SECRET               — for the Vercel cron GET
//   AGENT_WRITE_KEY           — for POST (reused from post-plan.js)
//   COPILOT_TELEGRAM_CHAT_ID / _BOT_TOKEN  — optional; else reuses TELEGRAM_PLAN_*
//   COPILOT_MODEL, COPILOT_EFFORT          — optional Claude overrides

const { getDb, runAnalysis } = require('./_kp_lib');

function bad(res, code, msg) { res.status(code).json({ ok: false, error: msg }); }

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

module.exports = async (req, res) => {
  // ── auth ──────────────────────────────────────────────────────────────────
  let force = false;
  let triggerType = null;

  if (req.method === 'GET') {
    // Vercel cron path (or manual GET with the agent key for testing)
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'] || '';
    const agentKey = req.headers['x-agent-key'];
    const cronOk = cronSecret && authHeader === `Bearer ${cronSecret}`;
    const agentOk = process.env.AGENT_WRITE_KEY && agentKey === process.env.AGENT_WRITE_KEY;
    if (!cronOk && !agentOk) return bad(res, 401, 'unauthorized');
    force = String(req.query.force || '') === '1';
    triggerType = req.query.trigger_type || null;
  } else if (req.method === 'POST') {
    const expected = process.env.AGENT_WRITE_KEY;
    if (!expected) return bad(res, 500, 'server_missing_agent_write_key');
    if (req.headers['x-agent-key'] !== expected) return bad(res, 401, 'bad_agent_key');
    let body;
    try { body = await readJson(req); }
    catch (e) { return bad(res, 400, 'invalid_json: ' + e.message); }
    force = !!body.force;
    triggerType = body.trigger_type || null;
  } else {
    return bad(res, 405, 'method_not_allowed');
  }

  // ── run ───────────────────────────────────────────────────────────────────
  try {
    const db = getDb();
    const result = await runAnalysis(db, { force, trigger_type: triggerType, source: req.method === 'GET' ? 'cron' : 'server' });
    return res.status(result.ok ? 200 : 500).json(result);
  } catch (e) {
    console.error('analyze error:', e);
    return bad(res, 500, String(e.message || e));
  }
};
