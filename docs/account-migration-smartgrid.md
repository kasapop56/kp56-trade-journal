# Account Migration — SmartGrid Real (135173655) replaces WaveRider Demo (49754423)

**Status:** ✅ COMPLETE (2026-07-23, same day)
**Context:** Smart Grid EA moving to new real account 135173655. Demo 49754423
will be auto-deleted by broker **~2026-08-06** (2 weeks from 2026-07-23).

## Plan

### Part A — Track new account 135173655

| Step | What | Who | Status |
|---|---|---|---|
| A1 | Attach JournalSync EA on new terminal — same webhook URL + `X-Journal-Secret` (no code change; Phase 6 multi-account handles the rest) | user | ✅ 2026-07-23 |
| A2 | `ACCOUNT_LABELS[135173655] = 'SmartGrid Real'` in js/accounts.js → push | Claude | ✅ 2026-07-23 deployed, verified on prod |
| A3 | Verify first snapshot/trade arrives → chip appears via v_accounts | Claude | ✅ 2026-07-23 first snapshot 04:19 UTC, balance $730, v_accounts shows 3 accounts |

Notes: `/plan` routine (sitrep-latest) still defaults to 87464504 — unaffected.
Grid EA's frequent deal closes are fine (per-deal upsert on `account_login,deal_ticket`).

### Part B — Preserve demo data (deadline ~2026-08-06)

| Step | What | Who | Status |
|---|---|---|---|
| B1 | Export final MT5 **HTML report** (full history) from demo terminal before deletion — only step with a hard deadline; broker history is unrecoverable after | user | ✅ 2026-07-23 exported |
| B2 | Permanent Supabase export → `trade-journal/archive/demo-49754423-waverider/` (JSON+CSV+README; 52 trades, 719 snapshots, trade_events empty) | Claude | ✅ 2026-07-23 |
| B3 | Detach EA from demo terminal when done — snapshots just stop, no side effects | user | ✅ 2026-07-23 (demo MT5 closed) |
| B4 | (optional) relabel chip → 'WaveRider Demo (ended)' after B3 | Claude | ✅ 2026-07-23 (ec64133) deployed+verified |

Demo rows stay in live Supabase — the journal chip keeps working forever;
the archive folder is the offline safety copy. `archive/` is **gitignored**
(would otherwise deploy as public static files on Vercel); it syncs via
Documents-in-iCloud instead. Do NOT rely on `backups/` (14-day prune).

## Demo account final-ish summary (as of archive date)

- 2026-06-11 → 2026-07-23: $135,179.58 → $137,937.42 (+$2,757.84)
- magic 5656 (WaveRider v1.10): 16 trades +$1,775.85 · magic 56 (later runs): 24 +$94.40 · magic 0 (manual): 12 +$887.59

## Step log

- 2026-07-23: plan approved; B2 archive exported + README written; A2 label
  committed (b713c48) + pushed → auto-deploy verified (label live, archive 404).
- 2026-07-23: user's MT5 couldn't see "Live Server 8" → fixed via Open-an-Account
  server-list refresh trick. A1 EA attached ✅, B1 final demo HTML exported ✅,
  A3 verified: first snapshot 04:19 UTC ($730), v_accounts = 3 accounts, chip live.
  Remaining: B3 detach demo EA when done + optional B4 relabel chip '(ended)'.
- 2026-07-23 (later): user closed demo MT5 (B3 ✅). Final HTML report parsed →
  archive gains `ReportHistoryDemo-2026-07-23-final.html` + parsed
  `mt5_report_positions.json/csv` (242 positions, 2026-05-11→07-23,
  $100k→$137,937.42). KEY FIND: report covers a month BEFORE journal sync began
  (2026-06-11) — 190/242 positions exist only in these files (incl. Smart Grid
  forward-test era, `Grid_Buy_*`/`Grid_Sell_*` comments). Cross-check clean:
  all 52 DB positions in report, deposit+netPL=final balance exact.
  Migration COMPLETE except optional B4.
- 2026-07-23: noted pre-existing uncommitted repo changes NOT touched: deleted
  supabase_schema*.sql files, modified phase-3c/phase-5 docs, untracked
  Mario.rtf/analyze.*/mockup-parta.html — user to review separately.
