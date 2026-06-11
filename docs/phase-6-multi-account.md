# Phase 6 — Multi-Account Support (Real + WaveRider Demo)

**Status:** ✅ Built + DB migrated (2026-06-11) · ⚠️ needs `npx vercel --prod` redeploy (user auths)

**Goal:** Journal the WaveRider v1.10 forward-demo (XAUUSD M5, magic 56560100) on a
separate demo account WITHOUT polluting real-account (87464504) stats. Account
separation in schema + UI switcher.

## Exploration findings (what exists today)

| Layer | Account-aware? | Notes |
|---|---|---|
| JournalSync EA | ✅ yes | Sends `account_login` from `AccountInfoInteger(ACCOUNT_LOGIN)` (line 36/188). **No EA change needed** — just attach the same EA to the demo terminal with the same webhook URL + secret. |
| `api/ingest.js` | ✅ stores it | `account_login` is required on both events. ⚠️ BUT upsert is `onConflict: 'deal_ticket'`. |
| `mt5_trades` table | ⚠️ partial | Has `account_login NOT NULL` + index, **but `UNIQUE (deal_ticket)` is global** — a demo-server deal ticket that collides with a real ticket would silently OVERWRITE the real trade. Must become `UNIQUE (account_login, deal_ticket)`. |
| `balance_snapshots` | ✅ | Has `account_login` + `(account_login, recorded_at)` index. |
| `v_trades_unified` view | ❌ no | Does NOT expose `account_login` or `magic` → frontend cannot filter. View must be recreated with these columns (NULL/real for the MANUAL arm). |
| History tab (`js/app.js`) | ❌ no | Queries view with direction/outcome/source filters only. |
| Dashboard (`js/dashboard.js`) | ❌ no | Same view, no account filter — demo trades would mix into all stats. |
| Portfolio (`js/balance.js`) | ⚠️ fragile | Picks "most recently active account" from `balance_snapshots` → would FLIP to the demo account as soon as the demo EA posts a snapshot. |
| `api/sitrep-latest.js` | ❌ no | `recent_trades` has no account filter → demo trades would pollute the /plan Telegram routine. |
| `js/import.js` | ✅ | Hardcodes real account for HTML imports — fine as-is. |

Live data check (2026-06-11): only account 87464504 present — 832 trades, 1782 snapshots.

## Change set (implemented 2026-06-11)

1. **SQL migration** (`supabase_schema_phase6.sql`, run in Supabase SQL editor):
   - `ALTER TABLE mt5_trades DROP CONSTRAINT mt5_trades_deal_ticket_key; ADD UNIQUE (account_login, deal_ticket);`
   - Recreate `v_trades_unified` adding `account_login` + `magic` to the MT5 arm
     (`87464504` + `NULL` for the MANUAL arm, since manual journal = real account).
2. **`api/ingest.js`**: upsert `onConflict: 'account_login,deal_ticket'` (1 line).
3. **`api/sitrep-latest.js`**: filter trades `.eq('account_login', account)` —
   default `87464504`, overridable via `?account=` (keeps /plan routine on real acct).
4. **Frontend account switcher** (chips: `Real · Demo-WaveRider · All`,
   persisted in localStorage, **default = Real**):
   - account list discovered dynamically (`distinct account_login`), labels from a small map
   - `app.js` history query: `.eq('account_login', …)` when not All; MANUAL rows count as Real
   - `dashboard.js`: same filter on its view query
   - `balance.js`: use the selected account instead of "most recently active"
5. **MT5 side**: no code change — attach JournalSync.mq5 to the WaveRider demo terminal,
   set the same webhook URL + `X-Journal-Secret`.

Deploy: `npx vercel --prod` (user authorizes). No local preview (house rule).

## Decisions (user approved 2026-06-11)

- Manual trade_ideas count as Real-account rows (view hardcodes 87464504 in MANUAL arm).
- Default view = Real. Selection persists in localStorage `kp56_account` ('ALL' or login).
- Account switcher bar stays hidden until ≥2 accounts have data; chips appear
  automatically once the demo EA posts its first trade/snapshot (`v_accounts` view).
- Portfolio card on "All" falls back to Real (balance curves can't merge).
- Demo label: add the demo login to `ACCOUNT_LABELS` in `js/accounts.js` once known
  (e.g. `12345678: 'WaveRider Demo'`); unlabeled accounts show as `#login`.

## Files touched

- `supabase_schema_phase6.sql` — migration (RUN on live DB 2026-06-11, verified:
  constraint swapped, view has account_login+magic, v_accounts returns 87464504)
- `api/ingest.js` — upsert onConflict `account_login,deal_ticket`
- `api/sitrep-latest.js` — `?account=` param, default 87464504 (protects /plan routine)
- `js/accounts.js` (NEW) — switcher state + bar; `index.html` loads it after app.js
- `js/app.js` — history query account filter
- `js/dashboard.js` — dashboard fetch account filter
- `js/balance.js` — portfolio uses selected account (was: most-recently-active = bug)
- `css/style.css` — `.account-bar` styles
- `index.html` — `#accountBar` div under nav + script tag

## Step log

- 2026-06-11: explored EA / webhook / live Supabase schema / view / frontend; wrote proposal.
- 2026-06-11: user approved → ran DB migration (verified), implemented all code, node --check passed.
- 2026-06-11: user deployed (`vercel --prod`) + attached JournalSync to demo terminal.
  Verified prod: accounts.js served, #accountBar in HTML, anon REST sees v_accounts +
  account_login/magic in v_trades_unified. ✅ LIVE.
- ⏳ Demo account has NOT hit the webhook yet (v_accounts still shows only 87464504).
  Also noted: real account's last balance_snapshot = 2026-06-10 15:03 UTC (~1 day gap)
  — check that the real terminal/VPS is still running.
- NEXT: once first demo data arrives, add demo login to ACCOUNT_LABELS in js/accounts.js
  ("WaveRider Demo") — switcher bar then appears automatically.
