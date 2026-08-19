# Trade Journal — Backup

**Status:** ✅ Script ready at `trade-journal/backup/backup.sh`

## Run backup manually

```bash
cd /Users/kasapopprapaspongsa/Documents/KP56/trade-journal/backup && ./backup.sh
```

## What it does

1. Full `pg_dump` of Supabase DB (schema + data) → compressed `.sql.gz`
2. Exports 4 tables as CSV → zipped bundle
   - `trade_ideas`, `positions`, `mt5_trades`, `balance_snapshots`
3. Prunes files older than 14 days automatically

**Output folder:** `~/Documents/KP56/backups/`

## Auto-schedule (cron)

Runs daily at 08:00 local time — add this line via `crontab -e`:

```
0 8 * * * /bin/bash "/Users/kasapopprapaspongsa/Documents/KP56/trade-journal/backup/backup.sh" >> "/Users/kasapopprapaspongsa/Documents/KP56/backups/backup.log" 2>&1
```

> Note: macOS may block local cron silently. If the cron job doesn't fire, use a cloud-side scheduler instead (`/schedule`).

## One-time setup (if not done yet)

```bash
cd trade-journal/backup
cp .env.example .env          # then fill in SUPABASE_DB_PASSWORD
chmod +x backup.sh
brew install libpq && brew link --force libpq   # if pg_dump missing
./backup.sh                   # test run
```
