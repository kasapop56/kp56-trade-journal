#!/usr/bin/env python3
"""Analyze MT5 HTML report and print trading stats.
Usage: python3 analyze.py ReportHistory-87464504.html
"""
import sys, re
from html.parser import HTMLParser
from datetime import datetime
from collections import defaultdict

path = sys.argv[1] if len(sys.argv) > 1 else 'ReportHistory-87464504.html'

with open(path, 'rb') as f:
    buf = f.read()
if buf[:2] == b'\xff\xfe':
    html = buf[2:].decode('utf-16-le', errors='replace')
elif buf[:2] == b'\xfe\xff':
    html = buf[2:].decode('utf-16-be', errors='replace')
else:
    html = buf.decode('utf-8', errors='replace')

# Parse rows: collect <tr> contents, then extract visible <td>/<th> cells
class RowParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows = []
        self.in_tr = False
        self.cur_cells = []
        self.cur_text = []
        self.in_cell = False
        self.cell_hidden = False
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'tr':
            self.in_tr = True
            self.cur_cells = []
        elif tag in ('td', 'th') and self.in_tr:
            self.in_cell = True
            self.cur_text = []
            self.cell_hidden = 'hidden' in (a.get('class') or '').split()
    def handle_endtag(self, tag):
        if tag == 'tr' and self.in_tr:
            self.rows.append(self.cur_cells)
            self.in_tr = False
        elif tag in ('td', 'th') and self.in_cell:
            if not self.cell_hidden:
                self.cur_cells.append(''.join(self.cur_text).strip())
            self.in_cell = False
    def handle_data(self, data):
        if self.in_cell:
            self.cur_text.append(data)

p = RowParser()
p.feed(html)

DT_RE = re.compile(r'^\d{4}\.\d{2}\.\d{2}\s\d{2}:\d{2}:\d{2}$')

def f(x, default=0.0):
    try:
        return float(x.replace(' ', ''))
    except Exception:
        return default

positions = []
for cells in p.rows:
    # Anchor on buy/sell
    dir_idx = -1
    for i, c in enumerate(cells):
        if c.lower() in ('buy', 'sell'):
            dir_idx = i
            break
    # Layout: Time(open) | PositionID | Symbol | Type | Volume | Price | SL | TP | Time(close) | Price(close) | Commission | Swap | Profit
    if dir_idx < 3:
        continue
    if not DT_RE.match(cells[dir_idx - 3]):
        continue
    try:
        open_time = cells[dir_idx - 3]
        symbol = cells[dir_idx - 1]
        direction = cells[dir_idx].lower()
        volume = f(cells[dir_idx + 1])
        entry_price = f(cells[dir_idx + 2])
        sl = f(cells[dir_idx + 3]) or None
        tp = f(cells[dir_idx + 4]) or None
        close_time = cells[dir_idx + 5]
        close_price = f(cells[dir_idx + 6])
        commission = f(cells[dir_idx + 7])
        swap = f(cells[dir_idx + 8])
        profit = f(cells[dir_idx + 9])
    except IndexError:
        continue
    if not DT_RE.match(close_time) or volume <= 0 or entry_price <= 0 or close_price <= 0:
        continue
    positions.append({
        'open': open_time, 'close': close_time, 'symbol': symbol,
        'dir': direction, 'vol': volume, 'entry': entry_price,
        'sl': sl, 'tp': tp, 'close_price': close_price,
        'comm': commission, 'swap': swap, 'profit': profit,
    })

print(f'Parsed {len(positions)} positions')

# Group scaled entries
groups = defaultdict(list)
for pos in positions:
    k = f"{pos['dir']}|{pos['close']}|{pos['symbol']}"
    groups[k].append(pos)

def parse_dt(s):
    return datetime.strptime(s, '%Y.%m.%d %H:%M:%S')

trades = []
for ps in groups.values():
    ps.sort(key=lambda x: x['open'])
    total_vol = sum(p['vol'] for p in ps)
    total_profit = sum(p['profit'] for p in ps)
    total_swap = sum(p['swap'] for p in ps)
    total_comm = sum(p['comm'] for p in ps)
    net = total_profit + total_swap + total_comm
    avg_entry = sum(p['entry'] * p['vol'] for p in ps) / total_vol
    open_dt = parse_dt(ps[0]['open'])
    close_dt = parse_dt(ps[0]['close'])
    dur_min = (close_dt - open_dt).total_seconds() / 60
    sl = ps[0]['sl']
    tp = ps[0]['tp']
    close_price = ps[0]['close_price']
    direction = ps[0]['dir']
    # Result tag
    tol = 0.5
    if tp and abs(close_price - tp) < tol:
        result = 'TP'
    elif sl and abs(close_price - sl) < tol:
        result = 'SL'
    elif abs(net) < 0.5:
        result = 'BE'
    else:
        result = 'MANUAL'
    # R multiple
    r_mult = None
    if sl:
        risk = abs(avg_entry - sl)
        if risk > 0:
            move = (close_price - avg_entry) if direction == 'buy' else (avg_entry - close_price)
            r_mult = move / risk
    trades.append({
        'symbol': ps[0]['symbol'], 'dir': direction,
        'open': open_dt, 'close': close_dt, 'dur_min': dur_min,
        'vol': total_vol, 'avg_entry': avg_entry, 'sl': sl, 'tp': tp,
        'close_price': close_price, 'profit': total_profit,
        'swap': total_swap, 'comm': total_comm, 'net': net,
        'result': result, 'r': r_mult, 'scaled': len(ps) > 1, 'pos_count': len(ps),
    })

print(f'Grouped into {len(trades)} trade ideas\n')

def pct(n, d): return (n / d * 100) if d else 0

wins = [t for t in trades if t['net'] > 0]
losses = [t for t in trades if t['net'] < 0]
flats = [t for t in trades if t['net'] == 0]

total_net = sum(t['net'] for t in trades)
total_comm = sum(t['comm'] for t in trades)
total_swap = sum(t['swap'] for t in trades)
gross_w = sum(t['net'] for t in wins)
gross_l = sum(t['net'] for t in losses)
avg_w = gross_w / max(1, len(wins))
avg_l = gross_l / max(1, len(losses))
expect = total_net / max(1, len(trades))
pf = abs(gross_w / gross_l) if gross_l else float('inf')
biggest_w = max((t['net'] for t in trades), default=0)
biggest_l = min((t['net'] for t in trades), default=0)

print('============ OVERALL ============')
print(f'Trades:           {len(trades)}')
print(f'Win rate:         {pct(len(wins), len(trades)):.1f}%  (W:{len(wins)} L:{len(losses)} BE:{len(flats)})')
print(f'Net P&L:          ${total_net:,.2f}')
print(f'  Gross profit:   ${gross_w:,.2f}')
print(f'  Gross loss:     ${gross_l:,.2f}')
print(f'  Commission:     ${total_comm:,.2f}')
print(f'  Swap:           ${total_swap:,.2f}')
print(f'Avg win:          ${avg_w:,.2f}')
print(f'Avg loss:         ${avg_l:,.2f}')
print(f'Win/Loss ratio:   {abs(avg_w/avg_l):.2f}' if avg_l else '')
print(f'Expectancy/trade: ${expect:,.2f}')
print(f'Profit factor:    {pf:.2f}')
print(f'Biggest win:      ${biggest_w:,.2f}')
print(f'Biggest loss:     ${biggest_l:,.2f}')

print('\n============ RESULT TAGS ============')
for tag in ['TP', 'SL', 'BE', 'MANUAL']:
    g = [t for t in trades if t['result'] == tag]
    if not g: continue
    w = sum(1 for t in g if t['net'] > 0)
    pnl = sum(t['net'] for t in g)
    print(f'{tag:<8} {len(g):>5}  win% {pct(w,len(g)):>5.1f}  net ${pnl:>12,.2f}')

print('\n============ DIRECTION ============')
for d in ['buy', 'sell']:
    g = [t for t in trades if t['dir'] == d]
    if not g: continue
    w = sum(1 for t in g if t['net'] > 0)
    pnl = sum(t['net'] for t in g)
    print(f'{d.upper():<6} {len(g):>5}  win% {pct(w,len(g)):>5.1f}  net ${pnl:>12,.2f}')

print('\n============ SCALED vs SINGLE ============')
for label, fn in [('Single', lambda t: not t['scaled']), ('Scaled', lambda t: t['scaled'])]:
    g = [t for t in trades if fn(t)]
    if not g: continue
    w = sum(1 for t in g if t['net'] > 0)
    pnl = sum(t['net'] for t in g)
    print(f'{label:<8} {len(g):>5}  win% {pct(w,len(g)):>5.1f}  net ${pnl:>12,.2f}')

print('\n============ BY HOUR OF ENTRY (broker server time) ============')
by_hr = defaultdict(list)
for t in trades:
    by_hr[t['open'].hour].append(t)
for h in sorted(by_hr.keys()):
    g = by_hr[h]
    w = sum(1 for t in g if t['net'] > 0)
    pnl = sum(t['net'] for t in g)
    print(f'{h:02d}:00 {len(g):>5}  win% {pct(w,len(g)):>5.1f}  net ${pnl:>12,.2f}')

print('\n============ BY DAY OF WEEK ============')
day_names = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
by_dow = defaultdict(list)
for t in trades:
    by_dow[t['open'].weekday()].append(t)
for d in sorted(by_dow.keys()):
    g = by_dow[d]
    w = sum(1 for t in g if t['net'] > 0)
    pnl = sum(t['net'] for t in g)
    print(f'{day_names[d]} {len(g):>5}  win% {pct(w,len(g)):>5.1f}  net ${pnl:>12,.2f}')

print('\n============ BY HOLD DURATION ============')
def bucket(m):
    if m < 1: return '<1m'
    if m < 5: return '1-5m'
    if m < 15: return '5-15m'
    if m < 60: return '15-60m'
    if m < 240: return '1-4h'
    if m < 1440: return '4-24h'
    return '>1d'
order = ['<1m','1-5m','5-15m','15-60m','1-4h','4-24h','>1d']
by_dur = defaultdict(list)
for t in trades:
    by_dur[bucket(t['dur_min'])].append(t)
for b in order:
    g = by_dur.get(b)
    if not g: continue
    w = sum(1 for t in g if t['net'] > 0)
    pnl = sum(t['net'] for t in g)
    print(f'{b:<8} {len(g):>5}  win% {pct(w,len(g)):>5.1f}  net ${pnl:>12,.2f}')

with_r = [t for t in trades if t['r'] is not None and abs(t['r']) < 100]
if with_r:
    print(f'\n============ R-MULTIPLE ({len(with_r)} trades with SL) ============')
    avg_r = sum(t['r'] for t in with_r) / len(with_r)
    print(f'Avg R: {avg_r:.2f}')
    r_bkts = [
        ('<-2R', lambda t: t['r'] < -2),
        ('-2..-1R', lambda t: -2 <= t['r'] < -1),
        ('-1..0R', lambda t: -1 <= t['r'] < 0),
        ('0..1R', lambda t: 0 <= t['r'] < 1),
        ('1..2R', lambda t: 1 <= t['r'] < 2),
        ('2..3R', lambda t: 2 <= t['r'] < 3),
        ('>=3R', lambda t: t['r'] >= 3),
    ]
    for k, fn in r_bkts:
        g = [t for t in with_r if fn(t)]
        if g:
            print(f'  {k:<9} {len(g)}')

print('\n============ BY MONTH ============')
by_mo = defaultdict(list)
for t in trades:
    by_mo[t['open'].strftime('%Y-%m')].append(t)
for m in sorted(by_mo.keys()):
    g = by_mo[m]
    w = sum(1 for t in g if t['net'] > 0)
    pnl = sum(t['net'] for t in g)
    print(f'{m} {len(g):>5}  win% {pct(w,len(g)):>5.1f}  net ${pnl:>12,.2f}')

# Streaks
max_w = max_l = cur_w = cur_l = 0
for t in sorted(trades, key=lambda x: x['open']):
    if t['net'] > 0:
        cur_w += 1; cur_l = 0; max_w = max(max_w, cur_w)
    elif t['net'] < 0:
        cur_l += 1; cur_w = 0; max_l = max(max_l, cur_l)
print(f'\nMax consec wins:   {max_w}')
print(f'Max consec losses: {max_l}')

# Per-day counts (overtrading)
by_date = defaultdict(int)
for t in trades:
    by_date[t['open'].date()] += 1
counts = list(by_date.values())
avg_day = sum(counts) / len(counts)
max_day = max(counts)
busy = sum(1 for n in counts if n >= 20)
print(f'\nTrading days:      {len(counts)}')
print(f'Avg trades/day:    {avg_day:.1f}')
print(f'Max trades/day:    {max_day}')
print(f'Days with >=20:    {busy}')

# Fatigue check
day_pnl = defaultdict(float)
for t in trades:
    day_pnl[t['open'].date()] += t['net']
day_stats = [(d, by_date[d], day_pnl[d]) for d in by_date]
low = [x for x in day_stats if x[1] < 10]
med = [x for x in day_stats if 10 <= x[1] < 30]
hi = [x for x in day_stats if x[1] >= 30]
def avg_pnl(xs): return sum(x[2] for x in xs) / len(xs) if xs else 0
print(f'\nDays <10 trades:   {len(low)}  avg day PnL ${avg_pnl(low):,.2f}')
print(f'Days 10-29:        {len(med)}  avg day PnL ${avg_pnl(med):,.2f}')
print(f'Days >=30:         {len(hi)}  avg day PnL ${avg_pnl(hi):,.2f}')
