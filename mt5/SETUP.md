# JournalSync EA — Setup

## 1. Vercel environment variables

In Vercel → Project → Settings → Environment Variables, add:

| Name | Value |
|---|---|
| `SUPABASE_URL` | `https://krnorbptbqticmpocdhc.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | *(Supabase → Project Settings → API → `service_role` secret key)* |
| `JOURNAL_SHARED_SECRET` | A long random string you generate — e.g. run `openssl rand -hex 32` in a terminal |

Redeploy after adding.

## 2. Supabase schema

In Supabase → SQL Editor, run the contents of `supabase_schema_phase2.sql` once.

## 3. MT5 setup (on the VPS)

1. Copy `JournalSync.mq5` into `MQL5/Experts/` (File → Open Data Folder from MT5 to find it).
2. In MetaEditor, compile it (F7). No errors expected.
3. In MT5: **Tools → Options → Expert Advisors**:
   - ✅ "Allow algorithmic trading"
   - ✅ "Allow WebRequest for listed URL"
   - Add URL: `https://kp56-trade-journal.vercel.app`
   - Click OK.
4. Drag `JournalSync` onto any chart (XAUUSDr works). In the inputs:
   - `WebhookURL` → leave default, or change if you use a custom domain
   - `SharedSecret` → paste the **exact same value** you set for `JOURNAL_SHARED_SECRET` in Vercel
   - `SymbolFilter` → `XAUUSDr` (or leave blank to capture all symbols)
   - `MagicFilter` → `0` (all)
   - `BalanceIntervalMin` → `60` is fine
5. Watch the MT5 **Experts** tab log. On init you should see a `balance_snapshot → HTTP 200`. Close a test position and you should see `trade_closed ... → HTTP 200`.

## 4. Verify in Supabase

```sql
select * from balance_snapshots order by recorded_at desc limit 5;
select * from mt5_trades      order by close_time  desc limit 5;
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `WebRequest failed: error=4060` | URL not in the whitelist — redo step 3.3. |
| `HTTP 401 bad_secret` | `SharedSecret` in EA doesn't match `JOURNAL_SHARED_SECRET` in Vercel. |
| `HTTP 500 server_missing_secret` | `JOURNAL_SHARED_SECRET` not set in Vercel, or deploy didn't pick it up. |
| EA attaches but no log | Make sure **algorithmic trading** is enabled (smiley face on chart). |
| `HTTP 500 db_error: ...JWT...` | `SUPABASE_SERVICE_ROLE_KEY` wrong or missing. |
