#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# KP56 Trade Journal — daily Supabase backup
#
# What it does:
#   1. pg_dump the entire Supabase DB (schema + data) to a .sql.gz file
#   2. Also exports the four key tables as CSV (human-readable, Excel-friendly)
#   3. Keeps the last KEEP_DAYS days of files, deletes older ones
#
# Setup (one-time):
#   1. cd trade-journal/backup && cp .env.example .env
#   2. Fill in SUPABASE_DB_PASSWORD in .env
#   3. Install pg_dump if missing: brew install libpq && brew link --force libpq
#   4. chmod +x backup.sh
#   5. Test manually: ./backup.sh
#   6. Schedule: crontab -e  →  add line from CRON SCHEDULE section below
#
# CRON SCHEDULE — runs every day at 08:00 local time:
#   0 8 * * * /bin/bash "/Users/kasapopprapaspongsa/Documents/KP56/trade-journal/backup/backup.sh" >> "/Users/kasapopprapaspongsa/Documents/KP56/backups/backup.log" 2>&1
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

# ── Load password ─────────────────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  echo "[backup] ERROR: $ENV_FILE not found. Copy .env.example → .env and fill in password."
  exit 1
fi
source "$ENV_FILE"

if [[ -z "${SUPABASE_DB_PASSWORD:-}" ]]; then
  echo "[backup] ERROR: SUPABASE_DB_PASSWORD is empty in $ENV_FILE"
  exit 1
fi

# ── Config ────────────────────────────────────────────────────────────────────
DB_HOST="db.krnorbptbqticmpocdhc.supabase.co"
DB_PORT="5432"
DB_NAME="postgres"
DB_USER="postgres"
PG_URI="postgresql://${DB_USER}:${SUPABASE_DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

OUT_DIR="$HOME/Documents/KP56/backups"
KEEP_DAYS=14
STAMP=$(date +%Y%m%d_%H%M)

mkdir -p "$OUT_DIR"

# ── Check pg_dump is available ────────────────────────────────────────────────
PG_DUMP=$(command -v pg_dump || command -v /opt/homebrew/opt/libpq/bin/pg_dump || true)
PSQL=$(command -v psql || command -v /opt/homebrew/opt/libpq/bin/psql || true)

if [[ -z "$PG_DUMP" ]]; then
  echo "[backup] ERROR: pg_dump not found."
  echo "         Install with: brew install libpq && brew link --force libpq"
  exit 1
fi

# ── Full SQL dump (schema + data, compressed) ─────────────────────────────────
DUMP_FILE="$OUT_DIR/kp56_full_${STAMP}.sql.gz"
echo "[backup] $(date '+%Y-%m-%d %H:%M:%S') — starting full dump → $DUMP_FILE"

"$PG_DUMP" "$PG_URI" \
  --no-owner \
  --clean \
  --if-exists \
  --no-privileges \
  | gzip > "$DUMP_FILE"

DUMP_SIZE=$(du -sh "$DUMP_FILE" | cut -f1)
echo "[backup] Full dump done: $DUMP_SIZE"

# ── CSV exports (key tables — human-readable, easy to open in Excel) ─────────
if [[ -n "$PSQL" ]]; then
  CSV_DIR="$OUT_DIR/csv_${STAMP}"
  mkdir -p "$CSV_DIR"

  for TABLE in trade_ideas positions mt5_trades balance_snapshots trade_events; do
    CSV_FILE="$CSV_DIR/${TABLE}.csv"
    "$PSQL" "$PG_URI" -c "\COPY ${TABLE} TO '${CSV_FILE}' WITH (FORMAT CSV, HEADER)" \
      2>/dev/null && echo "[backup] CSV: ${TABLE}.csv" \
      || echo "[backup] WARN: could not export ${TABLE} (table may not exist yet)"
  done

  # Zip the CSV folder
  ZIP_FILE="$OUT_DIR/kp56_csv_${STAMP}.zip"
  cd "$OUT_DIR" && zip -qr "$(basename "$ZIP_FILE")" "$(basename "$CSV_DIR")" && rm -rf "$CSV_DIR"
  ZIP_SIZE=$(du -sh "$ZIP_FILE" | cut -f1)
  echo "[backup] CSV bundle done: $ZIP_SIZE"
else
  echo "[backup] psql not found — skipping CSV export (full SQL dump still completed)"
fi

# ── Prune old backups ─────────────────────────────────────────────────────────
DELETED=$(find "$OUT_DIR" -maxdepth 1 \( -name "*.sql.gz" -o -name "*.zip" \) \
  -mtime +${KEEP_DAYS} -print -delete | wc -l | tr -d ' ')
[[ "$DELETED" -gt 0 ]] && echo "[backup] Pruned $DELETED file(s) older than ${KEEP_DAYS} days"

echo "[backup] $(date '+%Y-%m-%d %H:%M:%S') — done. Files in: $OUT_DIR"
