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

## Phase 8g — SL invalidation + fallback swing degree (2026-08-20)

**Problem.** A frame whose SL had been traded through kept being drawn, alerted and
sent as if it were live. Worse, in a one-way move the main frame cannot repair
itself: `ta.pivothigh(3,3)` needs the bar's high to beat 3 bars either side, so
during a sustained decline **no new pivot high can ever form** — `FH` stays pinned to
the pre-impulse top while `FL` ratchets down, and the frame drifts further from price
with every leg. Live example (2026-08-20 ~19:30, XAUUSD): FFS was holding
`FH 4494.87 · LH` / `FL 4480.72 · LL` with `B Focus 4466.57` and `B SL 4461.07` while
price traded 4454 — both anchors above price, SL long gone, zone still on the chart.
The trader's eye had already moved to the M5 leg 4467.73 → 4450.80.

**Rules.**

- **SL touched = frame dead** — the whole frame, not just that side. SL is the
  outermost layer (Focus 2.0 ± `slPts`), so reaching it means price left the entire
  structure; the untouched side is a target off a broken swing. **TP does not
  invalidate** — a level that was reached can still act as S/R afterwards.
- **Fallback degree.** On death, re-anchor to the same pivot rule on a finer TF
  (`fbTF`, default M5) — confirmed pivots only, so still no repaint. Accepted only
  if that frame was *created after* the death (`qFrId >= mDeadT`), which stops the
  M5 frame that died alongside the main one from being recycled. Its anchors may
  predate the death — the low that broke the SL is itself the new anchor.
- **WAIT** when both degrees are out — including when the M5 frame trips its OWN
  SL, which invalidates it by exactly the same rule. It does not fall further (no
  M1 rung); it waits for the next confirmed M5 frame, which resets that lane and
  returns to FALLBACK, or for M15 to recover. No zones, no signals, badge says so.
  Honest > invented. Note the split between *displayable* and *tradeable*: in WAIT
  the grey High/Low structure still comes from the M5 frame if there is one, because
  that is the more recent real structure — only the action levels are withheld. The
  alternative made the structure lines jump backwards to the older dead M15 frame on
  entering WAIT.
- **The fallback lane runs its own pivot strength** (`fbPiv`, default 2, separate
  from the main `pivLen` of 3). Dropping the TF alone was not enough: `f_box` takes
  the latest pivot high and the latest pivot low *independently*, so a 3-bar pivot
  on M5 that is too coarse to register the newest pullback low leaves a **fresh high
  paired with a stale low** — the M15 disease reproduced one degree down. Observed
  live 2026-08-20 20:49: the M5 frame read 4451.19 → 4484.56 while the actual current
  wave was 4469.30 → 4484.37; the tops agreed, only the low was stale. A finer pivot
  narrows the window where an unregistered low can be skipped. It does not close it
  completely — the independent-anchor design always permits some pairing gap — so
  `fbPiv` is an input: go to 1 if it still lags. `piv_len` in the payload and the
  table now report the ACTIVE lane's strength, not always the main one.
- **Minimum leg width** (`fbMinSep`, default 6 fallback bars = exactly 2 M15 bars).
  A finer pivot fixes the stale anchor but opens the opposite fault: an H and an L
  only 2–3 bars apart is a wiggle, not a leg, and it redraws the frame constantly.
  Separate lever from `fbPiv` — that one decides how readily a pivot is accepted,
  this one decides whether the resulting leg is long enough to be structure. The
  check runs BEFORE anything is written (`nFHbi`/`nFLbi` = where the anchors *would*
  land), so a rejected pivot leaves the frame completely untouched rather than
  moving one anchor and not the other. A rejected pivot is discarded for good; the
  frame waits for one far enough from the opposite anchor. Verified on a replay:
  3-bar pivots rejected with the frame frozen, 6+ bar legs accepted.
- **M5 is a recovery lane, not a co-owner** — M15 takes back control the moment it
  has a real leg again, and draws fresh levels. But "a new M15 frame exists" is NOT
  the test: after an impulse the new frame usually drags the stale `FH` along (no
  pivot high formed during the fall), giving a distorted, too-wide frame whose
  levels price never reaches — so it never trips its SL, never "dies", and would
  otherwise steal the job from the M5 leg that is actually correct. The real test
  is **a new pivot on BOTH sides after the death** (`mFhTm >= deathT and mFlTm >=
  deathT`) = M15 genuinely built a new swing. `deathT` therefore persists ACROSS
  redraws (`f_dead` resets per frame; `deathT` does not) until that is satisfied.
- **Anti-lock valve** (`fbMaxMin`, default 240 min). The both-sides rule normally
  clears in ~1–3h, but a one-way trend can starve M15 of new pivot highs for a whole
  session, which would strand the frame on M5 indefinitely. Past the deadline, the
  next M15 frame created after the death wins outright, both-sides or not. If that
  frame is in fact still bad it trips its own SL quickly and drops back to M5, so the
  valve cannot wedge a broken frame in place — worst case it costs one SL width. The
  snapshot carries `reclaim: "leg" | "timeout"` (in `raw`, no migration) so the two
  routes can be compared later rather than assumed equivalent.
- **Self-repair.** A newly drawn frame born already beyond its own SL dies on the
  same bar and falls straight back to M5 — which is what keeps the stale-`FH`
  garbage frames out without any extra range-sanity rule.

**TF invariance (regression, two rounds).** Round one moved SL detection out of a
chart-level helper. That was not enough: ANY accumulated `var` at chart level is
TF-dependent by construction, because the script runs once per CHART bar and
therefore samples the calc-TF values at chart-bar resolution. On an H1 chart a death
and a recovery occurring inside one H1 bar are simply never seen. Observed live at
21:44 — H1 showed MAIN while M15 and M5 showed WAIT, and H1 was the correct one (the
M15 frame's sSL 4544.37 and bSL 4401.37 had neither been touched). **All persistent
state now lives inside `f_box`**, which runs in the calc TF's own context; the chart
level only reads values and derives, holding no `var` of its own. Only the alert
hit-flags remain chart-level, which is the original intent.

**Recovery is now a price-position test, not a pivot-count test.** "New pivots on
BOTH sides after the death" proved far too strict: a clean one-way rally produces no
confirmed pivot high for hours, so the frame sat in WAIT — blind — through a 50-dollar
move it should have been reading. Replaced with: the M15 frame reclaims when it is
newer than the death, not itself dead, and **price sits inside the frame's working
band** (`FL − r/2 … FH + r/2`). That is the practical definition of "sensible": the
frame brackets where price actually is. It separates the two real cases correctly —
at 19:30 the stale frame (r=14, price 22 dollars below the band) is refused, while at
21:44 the current frame (r=44, price inside) is taken. A frame that later runs away
from price is killed by its SL as before, so the band test never has to catch that.

The original round-one description follows, since the first fault is still worth
knowing: it computed the SL touch at CHART level, on chart `high`/`low`, and the
anti-lock valve read chart `time`. That made the state machine depend on which
timeframe you happened to be looking at — switching the chart changed where the SL was detected, which changed
MAIN/FALLBACK/WAIT, which changed the frame on screen. It broke the indicator's
founding promise (`คำนวณกรอบจาก TF หลัก เสมอ -> ดูใน M5/M1 เส้นไม่เปลี่ยน`). SL
detection now lives INSIDE `f_box`, so each lane judges its own frame on its own
bars via `request.security`; the valve measures from `mFrId` (an M15 frame time)
instead of chart `time`; and the chart-level latch dropped its `barstate.isconfirmed`
gate, since every input it reads is already a security value that only moves on its
own TF's close. Nothing in the frame or state path reads a chart bar any more — chart
TF now affects only when zone/signal ALERTS fire, which was always the intent (run
them on M5).

**Where the state shows up.** On-chart label hanging under the Mid line —
`M15 based` / `M5 based · awaiting new M15` / `no frame · awaiting new M15`. It is
anchored to `mid`, NOT to `close`: `mid` only moves when the frame changes, so the
label sits still instead of chasing every tick (the first version anchored to price
and was too distracting to read). Which side lost its SL is deliberately not on the
chart — it is one row down in the table. Plus a "สถานะ" row in that table (dead
levels print `✖`, and the TF row now names `src_tf`, not the configured TF) · `state` / `src_tf` / `dead_side` on every
SNAPSHOT, ZONE and SIGNAL payload · Telegram (WAIT posts "กรอบตาย" with no levels;
FALLBACK signals carry "↩ ขาสำรอง TF5") · a chip on the Fibo tab card.

**Co-pilot.** `_kp_lib.js` withholds fibo levels entirely in WAIT and tells Claude to
build the read from MT5 structure alone and say there is no valid frame — dead zones
used to enter the ladder unchallenged. FALLBACK levels are tagged `·TF5` in the ladder
and flagged in the prompt as a lower-conviction (finer) degree. `fibo_state` /
`fibo_src_tf` are captured as attribution factors, so the open question — *do
FALLBACK-degree reads score like MAIN ones?* — gets answered from data rather than
assumed.

**Evaluator guard.** The snapshot now also fires on validity changes, so `fibo-eval`
and `fibo-sim` filter WAIT rows out and keep one row per source frame (`raw.frame_id`)
— otherwise a dead frame would be graded as a second trade, and a fallback frame
handed back and forth would be counted once per hand-off. Replay still starts at
`bar_time`, not `frame_id` (frame_id is the source-TF bar open and would re-open the
look-ahead window Phase 8f closed).

**Verified before deploy:** the M5 fallback frame reproduces the hand-drawn fib
exactly — `0.382 4461.26 · mid 4459.27 · Test 4446.20 · Focus 4433.87` — and a replay
of the real 19:00–19:40 sequence transitions MAIN → WAIT (at 4450.67, ~10 min) →
FALLBACK. A second replay covers the handover: an M15 redraw carrying a stale `FH`
does NOT reclaim control (stays FALLBACK), while a frame with both pivots formed
after the death does, and draws its own levels. Pine itself is **not compiled yet**
— needs a TradingView re-paste.

**Ships with:** `supabase_schema_fibo_state.sql` (3 nullable columns; NULL = MAIN).

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
