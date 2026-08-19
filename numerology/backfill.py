#!/usr/bin/env python3
"""
Backfill Thai astrology numerology fields on both mt5_trades and trade_ideas.
Run once after applying supabase_schema_phase4.sql in Supabase SQL editor.

Usage:
    python3 numerology/backfill.py          # skip rows already filled
    python3 numerology/backfill.py --all    # recompute every row

Requires: pip3 install requests  (already installed)
Credentials: numerology/.env  (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
"""
import os, sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
import requests

DAY_STARS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์']
BKK = timezone(timedelta(hours=7))


def load_env():
    env_path = Path(__file__).parent / '.env'
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def pair_middle(hour, minute):
    return (hour % 10) * 10 + (minute // 10)


def from_utc_iso(iso_utc):
    """Convert UTC ISO timestamp to Bangkok datetime."""
    t = datetime.fromisoformat(iso_utc.replace('Z', '+00:00'))
    return t.astimezone(BKK)


def from_bkk_date_time(date_str, time_str):
    """Combine date (YYYY-MM-DD) + time (HH:MM:SS) already in BKK."""
    dt = datetime.strptime(f'{date_str} {time_str}', '%Y-%m-%d %H:%M:%S')
    return dt.replace(tzinfo=BKK)


def star_fields(bkk_dt):
    dow = (bkk_dt.weekday() + 1) % 7   # Mon=0..Sun=6 → Sun=0..Sat=6
    return DAY_STARS[dow], dow + 1


def fetch_rows(session, base, headers, table, where, select):
    rows, offset, page = [], 0, 1000
    while True:
        r = session.get(
            f'{base}/{table}?select={select}{where}'
            f'&order=id.asc&offset={offset}&limit={page}',
            headers=headers, timeout=60,
        )
        r.raise_for_status()
        batch = r.json()
        rows.extend(batch)
        if len(batch) < page:
            break
        offset += page
        print(f'    fetched {len(rows)} so far...')
    return rows


def patch_rows(session, base, headers, table, pk_col, rows, payload_fn, label):
    success = fail = 0
    total = len(rows)
    for i, row in enumerate(rows, 1):
        try:
            payload = payload_fn(row)
            if payload is None:
                fail += 1
                continue
            r = session.patch(
                f'{base}/{table}?{pk_col}=eq.{row[pk_col]}',
                headers=headers, json=payload, timeout=30,
            )
            r.raise_for_status()
            success += 1
        except Exception as e:
            print(f'    ! {pk_col}={row[pk_col]}: {e}')
            fail += 1
        if i % 200 == 0 or i == total:
            print(f'    {i}/{total}  ({success} ok, {fail} fail)')
    return success, fail


def main():
    load_env()
    url = os.environ.get('SUPABASE_URL', '').rstrip('/')
    key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')
    if not url or not key:
        sys.exit('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in numerology/.env')

    do_all = '--all' in sys.argv
    base = f'{url}/rest/v1'
    headers = {
        'apikey': key,
        'Authorization': f'Bearer {key}',
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
    }
    where = '' if do_all else '&day_star=is.null'

    session = requests.Session()

    # ── 1. mt5_trades ─────────────────────────────────────────────────────
    print('\n── mt5_trades ─────────────────────────────────────────')
    rows = fetch_rows(session, base, headers, 'mt5_trades', where,
                      'deal_ticket,open_time')
    print(f'  rows to fill: {len(rows)}')

    def mt5_payload(row):
        try:
            bkk = from_utc_iso(row['open_time'])
            star, star_num = star_fields(bkk)
            return {
                'trade_date_th':    bkk.strftime('%Y-%m-%d'),
                'day_star':         star,
                'day_star_num':     star_num,
                'open_hour_th':     bkk.hour,
                'open_minute_th':   bkk.minute,
                'open_pair_middle': pair_middle(bkk.hour, bkk.minute),
            }
        except Exception as e:
            print(f'    compute error for {row}: {e}')
            return None

    ok, fail = patch_rows(session, base, headers, 'mt5_trades',
                          'deal_ticket', rows, mt5_payload, 'mt5_trades')
    print(f'  done: {ok} updated, {fail} skipped/failed')

    # ── 2. trade_ideas ────────────────────────────────────────────────────
    print('\n── trade_ideas ────────────────────────────────────────')
    rows = fetch_rows(session, base, headers, 'trade_ideas', where,
                      'id,date,entry_time')
    print(f'  rows to fill: {len(rows)}')

    def idea_payload(row):
        try:
            date_str = row['date']               # "2026-04-24"
            time_str = row.get('entry_time') or '00:00:00'
            if len(time_str) == 5:               # "09:32" → "09:32:00"
                time_str += ':00'
            bkk = from_bkk_date_time(date_str, time_str)
            star, star_num = star_fields(bkk)
            return {
                'day_star':          star,
                'day_star_num':      star_num,
                'entry_pair_middle': pair_middle(bkk.hour, bkk.minute),
            }
        except Exception as e:
            print(f'    compute error for {row}: {e}')
            return None

    ok, fail = patch_rows(session, base, headers, 'trade_ideas',
                          'id', rows, idea_payload, 'trade_ideas')
    print(f'  done: {ok} updated, {fail} skipped/failed')

    print('\n✅ Backfill complete')


if __name__ == '__main__':
    main()
