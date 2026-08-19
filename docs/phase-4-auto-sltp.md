# Phase 4 — XitAll Auto SL/TP

**Status:** ✅ Shipped + fully verified end-to-end 2026-04-27. BUY, SELL, and manual VPS click all plant SL/TP within 15-18ms of entry. Supabase rows confirm SL/TP land in `mt5_trades` correctly.

## TL;DR

Plant default SL/TP (in points) on every new position the moment it opens — both system-fired and manually-clicked orders. Goal: enforce the user's risk-rule discipline without relying on remembering to set SL/TP each click.

Defaults: **SL=555 pts, TP=1555 pts** (R:R ≈ 2.8) on XAUUSDr.

## What changed

**File:** `trade-journal/mt5/Xitall.txt` — bumped to v2.10. Single-file change, no schema or webhook impact.

### New inputs

```
EnableAutoSLTP            = true   // Master switch
AutoSL_Points             = 555    // SL distance in points from open
AutoTP_Points             = 1555   // TP distance in points from open
AutoSLTP_OverrideExisting = false  // false = fill only when SL/TP=0; true = always overwrite
```

Scope honors existing `InpTradeMgmtMode` magic filter — default `MAGIC_ALL` covers system + manual orders.

### Two trigger paths (defense in depth)

1. **`OnTradeTransaction`** — fires the instant `TRADE_TRANSACTION_DEAL_ADD` arrives with `DEAL_ENTRY_IN`. Sub-tick latency.
2. **Tick safety net** — `OnTick` calls `ScanAndApplyAutoSLTP()` every 10 ticks. Catches anything path 1 missed (position not yet selectable, EA reload, network glitch).

Both paths route through the same `ScanAndApplyAutoSLTP()` function. It's idempotent: positions that already have SL/TP are skipped (unless `OverrideExisting=true`).

### SL/TP math

```
BUY  → SL = open − 555·point   TP = open + 1555·point
SELL → SL = open + 555·point   TP = open − 1555·point
```

- Clamped to `SYMBOL_TRADE_STOPS_LEVEL` (HFM XAUUSDr usually 0; guard is defensive)
- `NormalizeDouble` to symbol digits
- Uses `TRADE_ACTION_SLTP` (modify-only, doesn't open new orders)

### Coexistence with existing logic

| System | Interaction |
|---|---|
| BE (Breakeven SL) | Auto-SL plants initial SL; BE later moves SL toward break-even when in profit. No conflict — BE always tightens, never loosens. |
| DD Protection | Independent layer. If DD fires before Auto-SL/TP can plant (sub-tick close), position closes without SL/TP. Acceptable — not lost data. |
| Partial Close | Unaffected — partial close reduces volume but keeps existing SL/TP. |

## Journal integration — none required

JournalSync's `trade_closed` payload already reads `DEAL_SL` / `DEAL_TP` from the closing deal (`JournalSync.mq5:132-133, 198-199`). The closing deal inherits whatever SL/TP was on the position at close time. So:

1. Order opens (SL=0, TP=0)
2. XitAll Auto-SL/TP fires within ms → SL/TP planted
3. Position closes (any reason) → closing deal carries the SL/TP value
4. JournalSync ships SL/TP in webhook → Supabase row gets correct values

Zero changes to `JournalSync.mq5`, `api/ingest.js`, or schema.

## Deploy state

| Layer | Status |
|---|---|
| Xitall.txt v2.10 | ✅ Code shipped 2026-04-27 |
| Compile + reload on MT5 | ✅ Done 2026-04-27 |
| Boot banner version + AutoSLTP status | ✅ Updated `OnInit()` Print to v2.10 + AutoSLTP ON/OFF + pts |
| BUY verification | ✅ pos=7241469597 — fired 15ms after entry |
| SELL verification | ✅ pos=7241471565 — fired 18ms after entry |
| Manual VPS click verification | ✅ Both above were opened manually on VPS, magic=0 still got SL/TP planted |

## Verification checklist

- [x] Experts log shows `[XitAll] AutoSLTP set pos=<ID> BUY/SELL SL=<px> TP=<px>` within 1 sec — observed 15-18ms latency on both trades, OnTradeTransaction path confirmed (tick safety net not needed)
- [x] **BUY** math verified: pos=7241469597, open≈4713.33 → SL=4707.78 (open − 5.55) ✓ TP=4728.88 (open + 15.55) ✓
- [x] **SELL** math verified: pos=7241471565, open≈4710.49 → SL=4716.04 (open + 5.55) ✓ TP=4694.94 (open − 15.55) ✓
- [x] **Manual click on VPS** → SL/TP planted (proves `MAGIC_ALL` filter handles magic=0 correctly)
- [x] Supabase row has sl/tp non-null — verified via SQL Editor 2026-04-27:
  - `7236842081` (buy) → open=4713.33, sl=4707.78, tp=4728.88 ✓
  - `7236844211` (sell) → open=4710.49, sl=4716.04, tp=4694.94 ✓
- [ ] Existing position with SL/TP already set → not modified (not yet exercised — `OverrideExisting=false` is the default; will be implicitly tested whenever an EA pre-sets SL/TP before XitAll fires)

### Verification SQL

```sql
select deal_ticket, position_id, type, open_price, sl, tp, profit
from mt5_trades
where deal_ticket in (7236842081, 7236844211)
order by deal_ticket;
```

Expected:
- `7236842081` (BUY)  → sl=4707.78, tp=4728.88, open_price≈4713.33
- `7236844211` (SELL) → sl=4716.04, tp=4694.94, open_price≈4710.49

## Risk note (informational)

User's `MaxDrawdown=27.5` (running with 500 in practice as a discretionary buffer). On XAUUSDr at 0.05 lot, 555 pts ≈ \$27.75 — close to DD trigger. So in practice, DD Protection often closes ahead of SL hit. That's by design — SL is a hard ceiling, DD is the soft active management.

If lot size grows beyond 0.05, SL becomes the operative limit (DD trips earlier). The user is aware.

## Open questions / future work

- **Per-symbol SL/TP** — current inputs are global. If user later trades non-XAUUSDr symbols regularly, may want per-symbol overrides.
- **R:R-aware sizing** — alternative: compute lot size from a fixed risk \$ amount given the SL distance, instead of fixed lot + fixed SL. Defer until user has data on whether 555-pt SL is the right shape.
- **SL_ONLY mode** — if scalping at Rainbow band 1-2 (TP rarely hit at 1555), TP becomes inert. Could add a mode toggle. Defer until pattern emerges in journal data.
- **Auto SL/TP visualization** — could draw the planted SL/TP as horizontal lines on chart for visual confirmation. Defer.

## Related files

- `mt5/Xitall.txt` v2.10 — feature lives here
- `mt5/JournalSync.mq5` — unchanged; already captures SL/TP at close
- `docs/phase-3c-rainbow-context.md` — sister Phase 3c (rainbow context capture)
