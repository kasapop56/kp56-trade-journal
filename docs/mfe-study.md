# MFE study — what the favourable-excursion record actually says

Run 2026-08-20 on 200 decided `fibo_outcomes` rows (win/loss), joined to their
`fibo_snapshots` frame to recover the entry level and the frame range. Every row
had MFE and MAE stored, so nothing had to be re-derived from bars.

MFE is stored as a PRICE, not a distance. Converted per side:
`S: (level − mfe) / 0.01`, `B: (mfe − level) / 0.01`.

## 1. The headline: losses are not instant

```
        n     median   p75     p90     max      (points in favour, from entry)
win    127     1098    2754    4852    9317
loss    73      454     542    1203    3973
```

**57 of 73 losses (78%) ran 300+ points in your favour before stopping out.** A
loss is rarely a trade that went wrong immediately — it is usually a trade that
was winning and gave it all back. That single fact is what makes the TP width the
dominant lever, far more than entry selection.

## 2. TP sweep — SL fixed at 550

Valid because MFE is tracked from entry until the stop closes the trade, so
`mfe ≥ X` means X was reached BEFORE the stop. Every decided trade re-scored:

```
   TP  wins   WR%   net pts  per trade
  300   184    92     46400      232.0
  400   173    86     54350      271.8   <- best
  500   153    76     50650      253.2   <- current
  600   136    68     46400      232.0
  700   118    59     37500      187.5
  900    85    42     13250       66.2
 1200    68    34      9000       45.0
 1500    52    26     -3400      -17.0
```

Two different-quality conclusions here, and they should not be treated alike:

- **Widening the TP is clearly bad.** 700 loses a third of the edge, 1500 goes
  negative. Large, monotone, robust.
- **400 beating 500 is +7% and probably noise.** Frames are heavily correlated
  (~88% agreement between consecutive frames), so the effective sample is far
  below 200. Do not re-tune 500 → 400 on this alone.

This kills the "we are leaving money on the table" intuition. A single trade with
2908 points of MFE feels like a missed 2900-point win, but it sits between p75 and
p90 — the median winner runs 1098, and holding for the tail loses more on the
trades that give it back than the tail pays.

## 3. Frame range predicts trade quality

The reason this study matters for frame evaluation:

```
 range (pts)     n    median MFE   WR    reached 1500+
    0 - 1000    18        840     56%        17%
 1000 - 2000   107        761     64%        25%
 2000 - 3000    56        892     64%        29%
 3000 - 5000    15       1377     80%        40%
```

"Reached 1500+" rises monotonically with frame width, 17% → 40%. Wider frames
produce trades that run further and win more often. The n=15 top bucket is thin,
but the direction is consistent across all four.

The 0–1000 bucket underperforming the 1000–2000 bucket is independent support for
the `fbMinRng` gate added the same day: narrow frames are measurably worse, not
just theoretically ugly.

## 4. Focus vs Test, again

```
 focus B   n=37   median MFE 1436   WR 68%
 focus S   n=49   median MFE 1056   WR 76%
 test  B   n=52   median MFE  626   WR 58%
 test  S   n=62   median MFE  637   WR 56%
```

Focus entries do not just win more often, they run roughly twice as far. Test
1.272 remains the weak mode on both axes.

## 5. What could NOT be answered — and why

A TP × SL grid was attempted and discarded. Scoring a tighter stop as "killed any
trade whose MAE exceeded it" produced −10 pts/trade at TP=300/SL=550, versus +232
from the sound one-dimensional sweep. The one-dimensional number is right and the
grid was wrong: **MFE and MAE are both stored as extremes with no ordering between
them.** 57 losses reached their MFE before their MAE, and the grid silently
assumed the opposite.

Stored extremes can answer "what if the target moved" (MFE necessarily precedes
the resolution) but NOT "what if the stop moved". That needs bar-by-bar replay —
`api/fibo-sim.js` already has the machinery.

## Standing conclusions

1. Do not widen the target. The data is unambiguous and it is the largest effect
   in the set.
2. Do not re-tune 500 → 400 yet. Revisit when the sample has more independent days.
3. Frame range is a real quality signal — worth surfacing per-frame and worth
   testing as an entry filter once `fbMinRng` has run for a while.
4. A tighter stop remains an open question that this data cannot close.
