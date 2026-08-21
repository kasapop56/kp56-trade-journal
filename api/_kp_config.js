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
  // Was 900, which silently truncated reads. Measured over 60 replayed reads
  // (doc §19.6): output p50 587, p90 818, and 4 of 60 (6.7%) hit the 900 cap dead
  // on — losing the LAST line, which is the machine-readable `PLAN:`. Those reads
  // fell back to the prose parser (`plan_source: 'parsed'`), the same lower-fidelity
  // path §17.2 traced verdict flips to. The cap must sit well clear of p90, because
  // the one thing it clips is the one thing the evaluator needs.
  // Cost is unaffected — output is billed on tokens generated, not on the ceiling.
  maxTokens: 1600,
  effort: process.env.COPILOT_EFFORT || 'low',   // low = fast/cheap; concise read
  // skip the Claude call if the merged state hash matches the last analysis
  // (nothing materially changed) — cost guard on top of debounce
  skipIfUnchanged: true,

  // ── manual endpoint ────────────────────────────────────────────────────────
  manualRateLimitSec: 45,    // min seconds between /api/analyze/now reads

  // ── live-position coaching ───────────────────────────────────────────────────
  // Reconstructs current open positions from trade_events (StudyLog OPEN/MODIFY/
  // CLOSE) for this account, then Claude coaches SL/TP + management. Server-side
  // only (service-role read of trade_events); no EA change.
  studyAccount: parseInt(process.env.COPILOT_STUDY_ACCOUNT, 10) || 87464504,
  positionLookbackDays: 30,   // how far back to scan OPEN events (catches long holds)
  coachPositions: true,       // include live-order coaching in the read
  // Ground-truth positions: prefer the kp_positions snapshot (JournalSync pushes
  // the whole live set every ~10s). The trade_events replay is only a fallback
  // when no snapshot row exists yet. Warn in the read if the snapshot is older
  // than this (PC terminal likely asleep → may not match the live account).
  positionsStaleWarnMin: 3,
  // XAUUSD contract: $1 of price move × 1.0 lot = $100 account P&L (100 oz/lot).
  // Used to convert price distance → real account USD for P&L / risk / reward.
  usdPerDollarPerLot: 100,

  // ── nightly report ───────────────────────────────────────────────────────────
  // Daily retrospective (23:30 Asia/Bangkok via Vercel cron) grading the day's
  // closed trades on 87464504: per-trade review, discipline, co-pilot loop check,
  // lessons. Reads mt5_trades + trade_events + kp_signals; posts to Telegram.
  reportEnabled: true,
  reportTzOffsetHours: 7,     // Asia/Bangkok (no DST) — defines the "trading day"
  reportMaxTrades: 60,        // safety cap on trades pulled per day
  reportModel: process.env.COPILOT_REPORT_MODEL || null,   // null → use CFG.model
  // 'low' = minimal thinking so max_tokens goes to the visible text (medium/high
  // thinking can eat the whole budget → empty body). Match the intraday reads.
  reportEffort: process.env.COPILOT_REPORT_EFFORT || 'low',

  // ── read evaluator (Phase 9 feedback loop) ───────────────────────────────────
  // api/kp-eval.js replays each co-pilot read (kp_signals) against the intraday
  // BAR feed, capped to the read's Bangkok day, and classifies what price did in
  // units of the DAILY ATR ladder (from kp_atr / the "Daily ATR Zones" indicator).
  // All thresholds are FRACTIONS of that day's ATR — deliberately observational;
  // tune from data after ~2 weeks (see project note), don't overfit early.
  eval: {
    lookbackDays: 30,     // how many days of reads to (re)evaluate per run

    // Trading-day boundary — decides how day_type / read-capping / ATR lookup cut
    // the day. SELECTABLE so it ports to other brokers:
    //   'chart'   = align to the ATR indicator's broker daily bar (day starts at
    //               dayCutUtcHour UTC) → day_type & the ladder MATCH what you see
    //               on the Daily ATR Zones indicator. Use when the ATR source and
    //               the chart you read are the same broker.
    //   'session' = Bangkok civil day (00:00 +07) → internally consistent with the
    //               report + Fibo cut; ATR used only as a magnitude. Broker-agnostic.
    //
    // THIS SETUP SPANS TWO BROKERS, so 'chart' mode's precondition does not hold:
    //   · levels + ATR source = TradingView "GBEBROKERS:XAUUSD" (its daily bar opens
    //     04:00 UTC = 11:00 Bangkok — measured from the alert's own timestamp)
    //   · execution + the BAR feed the evaluator replays = MT5 HFM "XAUUSDr"
    //     (daily bar opens 00:00 server, GMT+3/+2 with DST = 04:00/05:00 Bangkok)
    // In 'chart' mode the anchor open came from GBE while every price compared
    // against it came from HFM, and the 11:00–11:00 window disagreed with the
    // report + Fibo (which cut at 00:00 Bangkok). 'session' anchors the day to the
    // BAR feed's OWN first bar, so anchor and prices are both HFM and the whole
    // system shares one cut. ATR stays the indicator's — daily volatility is
    // ~broker-independent, and it is used only as a magnitude. kp_atr.day_open
    // survives as meta.ladder_open so on-chart level references still match TV.
    // Bonus: the ingest stamps atr_date as a Bangkok civil date, so only in
    // 'session' mode does that string agree with the evaluator's day index at every
    // hour of the clock (see the ATR-join note in _kp_eval.js).
    dayWindow: 'session',
    // For 'chart' mode ONLY: the UTC hour the ATR source broker's DAILY bar opens.
    // 4 = GBE gold, verified 2026-08-21 (its once-a-day alert landed 04:00:01 UTC).
    // Ignored in 'session' mode — kept so switching back is one word.
    dayCutUtcHour: 4,

    winAtr:      0.5,     // favorable move ≥ this × ATR (reached before adverse) = played out
    lossAtr:     0.5,     // adverse move ≥ this × ATR first = went against the read
    stallAtr:    0.25,    // both excursions < this × ATR = STALL ("นิ่ง")
    dayBalanceAtr: 0.5,   // day travel from open < this × ATR = BALANCE day
    dayTrendAtr:   1.0,   // day travel ≥ this × ATR = TREND day
    dayOutsizedAtr: 1.5,  // day travel ≥ this × ATR = OUTSIZED day
    zoneBufferPrice: 1.0, // $ tolerance for "price reached the zone"
    // Where inside the advised zone the pending order fills: 'near' (first touch,
    // worst price), 'mid', or 'far' (deep edge). Not cosmetic — the co-pilot places
    // its SL just beyond the FAR edge, so 'near' inflates risk several-fold and
    // flips outcomes. Measure with ?fill= before settling on a default.
    // 'mid' — the trader's own answer for where a zone entry actually fills.
    entryFill: 'mid',
    // A read whose price snapshot was older than this (minutes) is not graded: the
    // excursion baseline would be a price that no longer existed at read time.
    maxReadPriceAgeMin: 5,
  },

  // ── carry-forward digest (Phase 9, descriptive) ──────────────────────────────
  // runAnalysis injects a compact "what price did yesterday + key levels still in
  // play" block into the new day's read so today's read layers on top. Descriptive
  // only for now (informational context, not a rule that changes the call) — the
  // score-driven auto-adjust is deferred until the outcome data matures.
  carryForward: true,
  carryLookbackDays: 3,   // how many prior days of outcomes to summarize

  // Zone Freshness: at read time, count how many times price already TESTED each
  // nearest zone today (from the BAR feed) → fed into the read so the co-pilot can
  // flag a re-used zone as weaker (tighten / partial faster / require fresh
  // rejection). Also stored as an attribution factor (fresh vs retested).
  zoneFreshness: true,

  // ── factor attribution (Phase 9b) ────────────────────────────────────────────
  // Rolling "what works" learning: group read outcomes by the ingredients present
  // (Mario bias alignment, Fibo side, value-area, zone score/tags, ATR day-type,
  // session) → directional hit-rate per factor. Surfaced in the nightly report.
  // Wider window than daily accuracy; needs data to matter (honor small_sample).
  attributionLookbackDays: 30,
};
