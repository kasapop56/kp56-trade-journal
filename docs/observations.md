# Observation log

Running log of **discretionary observations** made while trading — things noticed
on the chart that are not yet a measured fact. Each entry stays here until the
evaluator can either confirm or kill it with data.

Rules for this file:

* An observation is a **hypothesis**, never a rule. Nothing here changes Pine, the
  EA, or the co-pilot prompt until it is tested.
* Every entry records the numbers that were true **at the moment of the
  observation**, so hindsight cannot quietly rewrite it.
* Every entry ends with **how to test it** — the exact table/field/query — and a
  note on what is currently *not* captured, because that is usually the blocker.

---

## OBS-001 — Quiet day after a heavy run: Test zones hold everything

**Observed:** 2026-08-21 (Fri) ~13:00 Bangkok, by user, live on the chart.
**Status:** PARTLY FALSIFIED 2026-08-21 — the two *causes* failed on 3 years of
data; the *state* (today was quiet, Test held) stands. See the update at the end.

> "หลังจากที่วิ่งมายาวๆหนักๆ วันนี้วอลุ่มจะบางๆ ตัว Fibo test เอาอยู่หมด
> หรืออาจเป็นเพราะวันศุกร์ด้วยก็ยังไม่ทราบ"

Claim, unpacked into three separable parts:

1. After an extended/violent directional run, the following session comes in thin.
2. On such a thin session, the **Test** level holds — price tags it and reverts,
   rather than running through into the Focus level or the stop.
3. Possible confound: it is a **Friday**.

### What the data said at the time of the observation

`fibo_outcomes`, entries grouped by Bangkok trading day (frames entered that day):

```
day              test W/L      focus W/L
2026-08-17 Mon    16 / 8        12 / 1
2026-08-18 Tue    11 / 5         8 / 3
2026-08-19 Wed    10 / 7        12 / 8
2026-08-20 Thu    22 / 11       17 / 7
2026-08-21 Fri     9 / 1         4 / 0      ← observation day, to 13:00 only
2026-08-14 Fri    10 / 6        11 / 1      ← the previous Friday
```

Today's Test win rate is **9/10 (90%)** against a ~63–67% recent baseline, and
Focus is 4/4. **Every single entry today was on the SELL side** — the day is one
directional fade, not a two-sided range, which matters: it may be "sells into a
pullback after a run" rather than "Test zones are strong today".

Volatility proxy from `fibo_snapshots` (frame range = `fh − fl`, and the span of
snapshot prices seen that day):

```
day              frames   median frame range   price span seen
2026-08-19 Wed     18            2023 pt          16386 pt   ← the heavy run
2026-08-20 Thu     22            2052 pt           4908 pt
2026-08-21 Fri     11            2403 pt           2576 pt   ← today, to 13:00
```

So "thin" shows up as a **compressed price span**, not as smaller frames — the
frames drawn today are ordinarily sized, price just is not travelling. That is
consistent with the mechanism the observation implies: pullbacks that reach a
level and die instead of continuing.

### Caveats that must not be lost

* **Partial day.** Recorded at 13:00 Bangkok, i.e. *before the NY session*. The
  quiet half is the half that has happened. Whether the day stayed quiet is a
  separate fact to check tomorrow, and if NY broke it, this entry weakens badly.
* **n = 1 day.** Ten entries on one side of one session. The previous Friday
  (2026-08-14) does not show the same Test dominance (10/6), which argues against
  the "it's Friday" explanation more than it argues for it.
* `kp_atr.day_open` for today is 4498.82, carried over from 2026-08-20 — the Pine
  `day_open` rollover bug is fixed in source but the fix is **not re-pasted on
  TradingView yet**, so any ATR-travel/day-type reading for today is unreliable.

### How to test this later

The three parts need different data, and one of them cannot be tested at all yet:

| Part | Testable now? | With what |
|---|---|---|
| Test-holds-on-quiet-days | **Yes** | Bucket days by realised travel (`fibo_snapshots` price span, or `kp_atr` day_type once `day_open` is trustworthy) → win rate of `mode='test'` vs `mode='focus'` in `fibo_outcomes`. |
| Prior-day-run → next-day-quiet | **Yes** | Same per-day span series, lag 1: does a top-decile span day predict a bottom-decile one? Purely a property of the day series, no trade data needed. |
| Friday effect | **Yes, one line** | `meta.factors` in `kp_read_outcomes` has `session`, `atr_day_type`, `vp_bucket`, zone fields but no day-of-week — it is derivable straight from `sig.ts`, and the BAR feed already carries `dow` (`RainbowPilot.mq5:354`). Adding `dow` to `buildFactors()` in `api/_kp_eval.js` puts it in the attribution report; it bumps `eval_version`. |
| "Volume is thin" | **Not as stated** | Nothing stores volume — not the Pine snapshot, not `kp_atr`, not the BAR feed. Every test above uses **range/travel as the proxy**, which for XAUUSD loses little: MT5/TV only ever report *tick* volume for spot gold, and tick count tracks range closely. See "Do we need volume?" below. |

Minimum before this is worth acting on: **~15 quiet days** classified the same
way, with Test-vs-Focus win rates separated. Until then it stays OPEN, and the
co-pilot is not told about it — feeding an untested pattern into the prompt is
exactly the contamination the feedback loop is supposed to avoid.

### Do we need volume? (asked 2026-08-21)

**No — not for this observation, and ATR alone is not the reason.**

* `kp_atr.atr` is a **10-day RMA**: it describes the *regime*, and it barely moves
  from one day to the next (88.81 → 89.25 across the heavy Wednesday). It can
  never say "today is quiet". What says that is **realised travel from the day's
  open**, which the evaluator already computes as `day_type` — so the capability
  exists, it is just gated on the `day_open` rollover fix reaching TradingView.
* Spot gold has no central exchange, so every "volume" figure available here is
  **tick volume**, which mostly restates range. It is also broker-local: the chart
  is GBE, the account is HFM, so tick counts are not comparable across the two
  feeds the pipeline already joins.
* The one thing volume separates that range cannot: **many ticks / narrow range**
  (absorption at a level — the case where Test genuinely *should* hold) versus
  **few ticks / narrow range** (nobody is trading — a level holds only because
  nothing is pushing it). A partial proxy for that split is already stored:
  **`spread`, logged on every bar** (`RainbowPilot.mq5:335`) — thin liquidity
  shows up as a wider spread.

If OBS-001 survives ~15 quiet days, the right way to add it is **relative volume**
(day vs its own 20-day average, so it is broker-neutral), emitted on the **Fibo
snapshot** alert — per M15 frame. Not on the `daily_atr` alert: that fires once,
on the first bar of the new day, so anything it carries describes *yesterday*.

### Update 2026-08-21 — both proposed causes fail on 3 years of data

Triggered by the follow-up question "should we store daily true range too?".
Built the series the pipeline does not store — daily TR, TR/ATR(10), close
location, body efficiency — from the 3y Dukascopy M1 set, 00:00 Bangkok cut, 789
trading days (2023-06 → 2026-06). Script: `rainbow-research/daily_shape.py`.

Quiet is defined as `TR / ATR(10)` in the bottom quartile — `q25 = 0.71`,
median `0.93`, `q75 = 1.22`.

**Part 1 — "after a heavy run, the next day is thin": WRONG, and backwards.**

```
P(quiet day)                  25.1%   (base rate)
P(quiet | previous day heavy) 19.7%   n=198
median TR/ATR after a heavy day  0.98  vs  0.93 overall
```

A heavy day makes the next day *less* likely to be quiet, not more — volatility
clusters, it does not exhaust. The premise is inverted.

**Part 3 — "or maybe because it's Friday": WRONG, and also backwards.**

```
        n    median TR/ATR   % quiet
Mon    158       0.86          32%
Tue    158       0.95          23%
Wed    158       0.85          31%
Thu    157       0.96          18%
Fri    158       1.03          21%     ← the most active day of the week
```

Friday has the highest median range of any weekday. Monday and Wednesday are the
quiet ones. So today was not quiet *because* it was Friday — it was quiet in
spite of it.

**What survives:** today *was* genuinely quiet and Test *did* hold 9/10. That is
still worth something — but it cannot be predicted from yesterday's range or from
the calendar. It has to be **detected live**, from realised travel against ATR,
and acted on within the day. Reframed as OBS-002.

**Consequence for the co-pilot:** nothing to add to the prompt. If anything this
removes a temptation — "big move yesterday, expect a quiet fade today" is a
losing prior.

---

## OBS-002 — Detect the quiet state live, don't predict it

**Opened:** 2026-08-21, from the wreckage of OBS-001. **Status:** OPEN.

The hypothesis worth keeping: **while `TR-so-far / ATR(10)` is running in its
bottom quartile, Test-level entries outperform**; when it is running hot, Focus
levels and continuation do. This is a *state* read intraday, not a forecast made
at the open.

Testable with what exists — no new capture: bucket every decided `fibo_outcomes`
row by the travel of its own day at entry time, then split Test vs Focus win rate.
The blocker is still the `day_open` rollover fix reaching TradingView.

---

## Decision 2026-08-21 — store daily TR and the day's O/H/L/C: YES

Cheap, and it buys a dimension the ATR ladder genuinely does not have.

**What ATR alone cannot say.** `atr` is a 10-day RMA — the regime. `TR / ATR` is
the *day*. Everything above needed that ratio, and none of it was computable from
the stored `kp_atr` rows.

**What open/close adds on top of range.** Split quiet days by body efficiency
`|C−O| / (H−L)`:

```
quiet days (n=198):  churn (eff < 0.35)  108  = 55%
                     trend (eff ≥ 0.65)   20  = 10%
```

Both look identical to ATR and to travel-from-open, and they are opposites at a
level: churn = price kept coming back, Test should hold; quiet-trend = a slow
one-way grind, Test gets run over. And this is not range restated — churn days
across the whole sample are only 36% quiet, so efficiency is close to an
independent axis.

That also narrows the earlier "only volume can separate absorption from an empty
market" claim: **range + efficiency + close location recover most of that split**,
which is another reason volume can keep waiting.

**How it was captured (shipped 2026-08-21, pending TV re-paste).** No new alert,
no new endpoint — the `daily_atr` alert already fires on the first bar of the new
day, so it can also report the day that just closed.

The previous day's OHLC is accumulated on the **chart's own bars**, on the same
`is_new_day` boundary the ladder uses — *not* through `request.security("D")`.
At the alert instant that series is still a day behind (that is precisely what
made `day_open` send 4498.82), so reading it there would be ambiguous by one day
and would silently break on any day the feed happened to roll over in time.

Two details that are easy to get wrong:

* **`prev_ts` is where the closed day STARTED, not where it ended.** The chart day
  is cut at 04:00 UTC = 11:00 Bangkok, so the day's last bar already carries the
  *next* civil date — labelling by the end would file every day under tomorrow.
  Labelling by the start also makes Monday's predecessor **Friday**, not Sunday.
* **`prev2_c` rides along** — the close of the day before that — so true range is
  computable from the payload alone: `TR = max(H−L, |H−prev2_c|, |L−prev2_c|)`.
  Without it a gap day silently degrades to plain H−L.

Server: `writePrevDay()` in `api/fibo-snapshot.js` patches the **previous day's**
row (`day_high` / `day_low` already existed unused; `day_close` / `tr` /
`prev_close` added by `db_kp_atr_daily_tr.sql`). It is deliberately outside the
main upsert and never fails the webhook — a missing migration must not cost us the
ATR frame the evaluator actually depends on.

Ratios stay derived at read time, not stored, so redefining "quiet" needs no
backfill. Note `atr` on a row is the ATR as of that day's *open*, so it excludes
that day's own range — which is what makes `tr / atr` an honest surprise measure.

The `day_open` fix needed no code change — it has been correct in the source since
2026-08-21 and was only ever waiting to be pasted onto the chart. Both ship in the
same paste.

History does not have to be waited for: `daily_shape.py` already reconstructs the
whole series back to 2023 from the M1 set.
