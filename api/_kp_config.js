// api/_kp_config.js — KP56 Co-pilot tunables (Phase 3).
// Not a route (underscore prefix). Required by _kp_lib.js.
//
// Everything price-based is in DOLLARS (XAUUSD), not MT5 "points", to avoid the
// ambiguous "pts" unit the SITREP uses. A gold zone edge buffer of ~$1 is a
// sensible "price is at the zone" threshold on M15/H1.

module.exports = {
  symbol: 'XAUUSD',

  // ── trigger engine ─────────────────────────────────────────────────────────
  // price within this many DOLLARS of a zone edge counts as "at the zone"
  zoneBufferPrice: 1.0,
  // a state older than this (minutes) is treated as "no data" for that source
  maxStateAgeMin: 180,
  // don't re-comment on the same trigger_type within this window …
  debounceMin: 20,
  // … unless price has moved at least this many DOLLARS since the last comment
  materialMovePrice: 6.0,
  // how many recent kp_market_state rows sweep-and-reclaim looks back over
  sweepLookback: 6,

  // which triggers are live. confluence_flip + momentum_flag stay dormant until
  // the Fibo Pine emits h4_trend / RBE-SBE flags (see supabase_schema_kp_copilot.sql).
  triggers: {
    zone_entry:      true,
    sweep_reclaim:   true,
    confluence_flip: true,   // guarded: no-op while h4_trend is null
    momentum_flag:   true,   // guarded: no-op while flags are absent
    manual:          true,
  },

  // ── delivery ───────────────────────────────────────────────────────────────
  telegram: true,            // fan out commentary to Telegram
  dashboard: true,           // always logged to kp_signals (dashboard reads it)

  // ── Claude ─────────────────────────────────────────────────────────────────
  // User's prompt asked for a Sonnet-class default; override with COPILOT_MODEL.
  model: process.env.COPILOT_MODEL || 'claude-sonnet-5',
  maxTokens: 900,
  effort: process.env.COPILOT_EFFORT || 'low',   // low = fast/cheap; concise read
  // skip the Claude call if the merged state hash matches the last analysis
  // (nothing materially changed) — cost guard on top of debounce
  skipIfUnchanged: true,

  // ── manual endpoint ────────────────────────────────────────────────────────
  manualRateLimitSec: 45,    // min seconds between /api/analyze/now reads
};
