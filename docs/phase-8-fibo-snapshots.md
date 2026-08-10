# Phase 8 — Fibo Focus Snapshots

Record every "กรอบใหม่" the **Fibo Focus Zone [B/S]** Pine indicator draws, ping
Telegram, and keep a browsable log in the journal. **Snapshot only — no Win/Loss
tracking yet.**

## Flow

```
Pine (FiboFocusSignals.pine)
  └─ alert() JSON on each new frame (seq resets daily)
        │ TradingView webhook
        ▼
  POST /api/fibo-snapshot   ── auth: body.secret == FIBO_WEBHOOK_SECRET
        ├─ insert → Supabase  fibo_snapshots
        └─ Telegram  "🟧 Fibo Focus — วาดใหม่ … Seq #N"
        ▼
  Journal UI  → tab "Fibo 🎯"  (reads fibo_snapshots via anon key)
```

## Files

| Piece      | Path                                  |
|------------|---------------------------------------|
| Pine       | `../FiboFocusSignals.pine` (KP56 root, indicator ⑥ Alert/Webhook) |
| Schema     | `supabase_schema_fibo.sql`            |
| Webhook    | `api/fibo-snapshot.js` (+ `vercel.json`) |
| UI page    | `js/fibo.js`, `#fibo` in `index.html`, `.fibo-*` in `css/style.css` |

## Deploy checklist

1. **Supabase** — run `supabase_schema_fibo.sql` in the SQL editor (creates
   `fibo_snapshots` + anon read policy).
2. **Vercel env vars** (Project → Settings → Environment Variables):
   - `FIBO_WEBHOOK_SECRET` — pick any string; must match the Pine input.
   - *(optional)* `FIBO_TELEGRAM_CHAT_ID` / `FIBO_TELEGRAM_BOT_TOKEN` to send to a
     different chat/bot. If unset, reuses `TELEGRAM_PLAN_*`. Set
     `FIBO_TELEGRAM_CHAT_ID=off` to skip Telegram entirely.
   - `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` already exist.
3. **Deploy** — `git push` (auto-deploys, per project rule — never `vercel --prod`).
4. **TradingView**:
   - Add the indicator to an XAUUSD chart. In settings ⑥ set **Webhook secret** =
     the same `FIBO_WEBHOOK_SECRET`.
   - Create an alert: Condition = *Fibo Focus Zone*, **Once Per Bar Close**,
     Webhook URL = `https://<journal-domain>/api/fibo-snapshot`.
   - Leave the alert message as `{{...}}`? **No** — the indicator builds the full
     JSON itself via `alert()`, so the alert "message" box is ignored; just enable
     the webhook. (Requires a TradingView plan with webhooks.)

## Data contract (JSON body)

`secret, symbol, tf, seq, frame_no, entry_mode, zone_pts, price, bar_time,`
`fh, fl, mid, s_focus, s_test, s_tp1, s_tp3, s_sl, b_focus, b_test, b_tp1, b_tp3, b_sl`

`seq` resets to 1 each new trading day; `frame_no` is a monotonic per-chart counter.
The whole payload is also stored in `fibo_snapshots.raw` (jsonb) for future fields.

## Phase 8b — Win/Loss tracking

Pine now runs a per-side state machine and fires lifecycle events through the SAME
webhook (routed by a `type` field):

- **ENTER** — price reached the entry zone. `Test 1.272` = bar **closes** inside the
  ±zone; `Focus 2.0` = price **touches** the zone edge (extension spike/wick).
- **WIN** — TP1 (500p) hit before SL.  **LOSS** — SL hit before TP1.
- **VOID / no-entry** is not emitted; the UI infers it (a frame side with no ENTER
  once a newer frame exists).

Each event carries `type, frame_id, side (S/B), entry, tp1, sl, mfe`. `frame_id` =
the drawing bar's ms-epoch = `fibo_snapshots.bar_time` (the join key). `mfe` = max
favorable price since entry; the webhook maps it against the frame's TP ladder to
report "best TP reached".

**⚠️ Runs on the chart TF = calc TF (M15).** Keep the alert on an M15 XAUUSD chart
for accurate touch detection. Tie-break: if a bar hits both TP1 and SL, counts LOSS.

### Extra files (8b)
| Piece   | Path |
|---------|------|
| Schema  | `supabase_schema_fibo_events.sql` (table `fibo_events`) |
| Pine    | indicator group ⑦ Win/Loss tracking (`alWL`) |
| Backend | `api/fibo-snapshot.js` branches `type` → `handleEvent` |
| UI      | `js/fibo.js` merges events → per-side badge + daily W/L bar |

### Deploy (8b)
1. Run `supabase_schema_fibo_events.sql` in Supabase.
2. `git push` (redeploys the webhook + UI).
3. The existing TradingView alert already covers it — "Any alert() function call"
   forwards every `alert()` (snapshot + events) to the same webhook. No new alert
   needed. (Keep the alert on an M15 chart.)

## Phase 8c — data-driven # evaluator (track ALL frames) + breakdowns

**Why:** Pine group ⑦ only tracks the *active* frame — when a zone break redraws
the frame, the old #'s levels are abandoned. But if price later reaches an old #'s
zone and runs to TP/SL, that's still a valid setup worth studying. Since every #
already stores all its levels, we don't need Pine to track old frames — we replay
the stored levels against a recorded price path. **No Pine change, no EA change.**

**Price source:** the RainbowPilot EA already streams one **BAR** event per closed
bar into `trade_events` (`payload.ctx.bar1 = [open,high,low,close]`,
`payload.t_gmt` = GMT close time, symbol `XAUUSDr`). That's the price feed.

**Evaluator — `api/fibo-eval.js`:**
- `GET /api/fibo-eval` → read-only diagnostics (feed presence, usable bars, overlap).
- `GET /api/fibo-eval?write=1&days=N` → for every `fibo_snapshots` # in the window,
  replays **both sides** against the BAR OHLC and **upserts `fibo_outcomes`**.
- Replay mirrors Pine ⑦: entry level = Focus 2.0 / Test 1.272 (per `entry_mode`),
  zone = ±`zone_pts`×0.01. **ENTER** Test = bar closes in zone / Focus = high≥zone
  (S) or low≤zone (B). **WIN** TP1 before SL, **LOSS** SL first, **tie = LOSS**
  (OHLC can't order intrabar). MFE → `best_tp` (0–4). Paginates past Supabase's
  1000-row cap; matches `XAUUSD` ~ `XAUUSDr`.

**Table `fibo_outcomes`** (`supabase_schema_fibo_outcomes.sql`): PK (frame_id, side),
`status` pending/entered/win/loss + entered_at/resolved_at/result/mfe/best_tp. Upsert
(not append) so a side can transition as more bars arrive. Anon read policy.

**No cron:** the Fibo tab pings `?write=1` on every render (tab open + ↻ รีเฟรช),
so opening the tab re-derives outcomes. (We avoid cron — it's been unreliable on
this stack; Pro caps routines at 5 runs/day.)

**UI (`js/fibo.js`):** badges + the two breakdown tables (**แยกตาม Session**
ASIA/LONDON/OVERLAP/NY/QUIET, **แยกตามดาว ⭐** Thai day-of-week) read `fibo_outcomes`.
Old superseded #'s now stay **PENDING** until their zone is touched, then resolve —
no more VOID inference. Session/star grouping keys off the frame's `bar_time`
(UTC-hour boundaries as `app.js deriveSession()`; day = Bangkok `bar_time+7h`).
Breakdown tables hide until ≥1 win/loss (`.fibo-breakdown:empty`).

**Pine group ⑦ WIN/LOSS is now redundant** (fibo_outcomes is the source of truth) —
left running as a live convenience; can be retired. `fibo_events` no longer read by
the UI.

**Verified 2026-08-10:** #1 B (Focus 4319.38, superseded by #2) correctly resolved
**WIN** from real BAR data — the exact case that had shown no entry under Pine.

## Phase 8c.2 — both entry modes + extent + mode-less Pine

**Both modes:** the evaluator now replays EACH (frame, side) in BOTH Focus 2.0 and
Test 1.272 from the same price data → `fibo_outcomes` PK is `(frame_id, side, mode)`.
`sideLevels(frame, side, mode)` gets the entry level per mode and computes TP1/SL as
fixed point offsets: it prefers the payload's `tp1_pts`/`sl_pts` (mode-less Pine),
else recovers the offsets from a legacy frame's stored TP1/SL. UI shows a line per
mode on each side + a **เทียบ Focus vs Test** table (decided, WR, mean best-TP, mean
heat). Headline stats + session/star breakdown use the active/primary (focus) mode.

**Extent vs result:** `result` = first of TP1-vs-SL (tie = LOSS). `mfe`/`best_tp`
track favorable extent to SL-close (past TP1 → "how far if held"). `mae` = heat only
until the trade first resolved (not the post-win giveback).

**Pine is now mode-less** (`FiboFocusSignals.pine`): removed the entry-mode input and
the whole group ⑦ WIN/LOSS state machine (redundant — evaluator owns W/L). Draws both
Focus (solid) and Test (dashed) always; **line labels show PRICE** (e.g. `S Focus
4381.57`) so the on-chart table can be hidden on mobile. Snapshot JSON sends
`tp1_pts`/`sl_pts` instead of `entry_mode`; `api/fibo-snapshot.js` stores the whole
payload in `raw`, so no webhook change was needed. Frame still redraws off Focus 2.0.

## Parked — Buffer / behavior study (build when ~2 weeks of frames exist)

Requested 2026-08-10; deferred until enough frames accumulate (was 5). All of it is
computable RETROACTIVELY from stored snapshots + the M5 BAR feed, so nothing needs
capturing now — just let frames collect, then build the evaluator metrics + a
per-session (and per Focus/Test) panel. Goal: decide whether SL/TP/entry need a
points buffer, and whether it differs by market session.

Metrics to add to `api/fibo-eval.js` (a second replay pass per side/mode):
- **Entry** — zone near-miss: price came within N pts of the zone but never entered,
  then reversed (→ widen zone?). Entry overshoot: how deep the wick pushed past the
  entry level on the entry bar (→ entry precision).
- **SL** — overshoot past SL in points for losers; **SL-rescue rate** = % of losers
  that WOULD reach TP1 if held past SL (continue the replay past the SL hit). High
  rescue → SL too tight, add buffer.
- **TP** — TP shortfall: for entered-but-not-won, MFE as % of the TP1 distance
  (→ is TP1 just out of reach? pull it in / add a nearer partial).

Present as a "Buffer study" panel: per session × mode, show the three above.

**Also in the same study package (same data, same wait):**

- **Management: hold-to-TP/SL vs redraw-invalidates.** The "hold" side already exists
  — `fibo_outcomes` holds every frame to TP1/SL regardless of newer frames. Add the
  "redraw" side: for an entered trade on frame F, if it hasn't resolved by the time
  the next frame (next `bar_time` for the symbol) draws, exit at the BAR-feed price at
  that moment (mark-to-market). Compare aggregate expectancy (R) of the two styles →
  is it better to hold the setup or cut it when a new frame appears?

- **Exit target: full TP vs TP2 vs TP1.** Nearly free — `best_tp` (deepest TP reached
  before SL) is already stored. Simulate exit-at-TP‑n: win iff `best_tp ≥ n`, else the
  trade rides to SL = loss. Compute per-rule win-rate and R (R_TPn = |TPn−entry| /
  |SL−entry|; TP1 = 500/550 ≈ 0.91R) → expectancy per target → is TP1 enough or is it
  worth holding for TP2/TP4? Break out by Focus/Test × session.

**Also in the package — Regime tagging (Range/SW vs Trend):**

Hypothesis: Fibo Focus is a mean-reversion-from-extension play → should WIN in
range/sideways and bleed in trend. So regime is likely the make-or-break filter
(same conclusion the Mario system reached: "regime cutoff is the blocker").

- **Tag every frame's regime SERVER-SIDE from the BAR feed** (M5 OHLC already
  stored) — compute over the bars around each frame: ADX (<20 range / >25 trend),
  Kaufman Efficiency Ratio (low=chop / high=trend), and/or EMA-ribbon slope/spread.
  Fully retroactive, NO Pine change. Then slice all outcomes (WR, best_tp, MFE/MAE)
  by regime → does it only work in range?
- Decision after data: (a) just **filter by regime** (keep the current frame logic),
  or (b) change how frames anchor.

**Frame anchoring — fixed lookback vs real swings (bigger, decide later):**
The current frame = `iHighest/iLowest` over `lookback` bars — crude, ignores swing
structure. Better = anchor to confirmed **swing/pivot highs & lows (ta.pivothigh/low
or ZigZag)** so the frame IS the last wave, and/or make lookback/zone ATR-adaptive.
This IS a Pine change (re-paste) — only pursue if the regime study shows a filter
isn't enough. For the study we can at least score each frame's "swing quality" from
the BAR feed without changing Pine.

Pickup trigger: user says "เริ่ม buffer study" (or ~2026-08-24). Regime tagging &
swing scoring are server-side/no-Pine; only the swing-anchored frame redraw needs Pine.

## Not done yet (later)

- Partial-close / scale-out modeling (best-TP is a first cut).
- Optional frame expiry (a # stays PENDING forever until its zone is touched).
