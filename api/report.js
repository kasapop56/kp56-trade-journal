// api/report.js — KP56 Co-pilot nightly report endpoint (Phase 5 loop-closer).
//
//   GET  /api/report   — Vercel cron (23:30 Asia/Bangkok). Auth: Authorization:
//                        Bearer <CRON_SECRET> or X-Agent-Key. Skips silently on
//                        no-trade days.
//   POST /api/report   { manual:true }  — manual trigger from you; always posts
//                        (a "no trades" note if the day was flat). Rate-limit-free
//                        but you own the button.
//   POST /api/report   + X-Agent-Key    — server-to-server.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, CRON_SECRET,
//      AGENT_WRITE_KEY, TELEGRAM_PLAN_* (or COPILOT_TELEGRAM_*).

const { getDb, CFG } = require('./_kp_lib');
const { runReport } = require('./_kp_report');

function bad(res, code, msg) { res.status(code).json({ ok: false, error: msg }); }

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

module.exports = async (req, res) => {
  if (!CFG.reportEnabled) return res.status(200).json({ ok: true, posted: false, reason: 'report_disabled' });

  let force = false, source = 'cron';

  if (req.method === 'GET') {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'] || '';
    const agentKey = req.headers['x-agent-key'];
    const cronOk = cronSecret && authHeader === `Bearer ${cronSecret}`;
    const agentOk = process.env.AGENT_WRITE_KEY && agentKey === process.env.AGENT_WRITE_KEY;
    if (!cronOk && !agentOk) return bad(res, 401, 'unauthorized');
  } else if (req.method === 'POST') {
    let body;
    try { body = await readJson(req); }
    catch (e) { return bad(res, 400, 'invalid_json: ' + e.message); }
    if (body.manual === true) { force = true; source = 'manual'; }
    else {
      const expected = process.env.AGENT_WRITE_KEY;
      if (!expected) return bad(res, 500, 'server_missing_agent_write_key');
      if (req.headers['x-agent-key'] !== expected) return bad(res, 401, 'bad_agent_key');
      source = 'server';
    }
  } else {
    return bad(res, 405, 'method_not_allowed');
  }

  try {
    const db = getDb();
    const result = await runReport(db, { force, source });
    return res.status(result.ok ? 200 : 500).json(result);
  } catch (e) {
    console.error('report error:', e);
    return bad(res, 500, String(e.message || e));
  }
};
