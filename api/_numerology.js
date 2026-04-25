// Thai astrology numerology derivation from a UTC ISO timestamp.
// Anchor: Asia/Bangkok (UTC+7, no DST). Used by ingest.js for new trades
// and by numerology/backfill.mjs for historical rows.

const DAY_STARS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

function bangkokParts(isoUtc) {
  const t = new Date(isoUtc);
  if (Number.isNaN(t.getTime())) throw new Error('invalid_timestamp: ' + isoUtc);
  const bkk = new Date(t.getTime() + 7 * 3600 * 1000);
  return {
    year:   bkk.getUTCFullYear(),
    month:  bkk.getUTCMonth() + 1,
    day:    bkk.getUTCDate(),
    dow:    bkk.getUTCDay(),     // 0=Sun … 6=Sat
    hour:   bkk.getUTCHours(),
    minute: bkk.getUTCMinutes(),
  };
}

function numerologyFromOpenTime(isoUtc) {
  const p = bangkokParts(isoUtc);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    trade_date_th:    `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    day_star:         DAY_STARS[p.dow],
    day_star_num:     p.dow + 1,
    open_hour_th:     p.hour,
    open_minute_th:   p.minute,
    open_pair_middle: (p.hour % 10) * 10 + Math.floor(p.minute / 10),
  };
}

module.exports = { numerologyFromOpenTime, DAY_STARS };

// Quick CLI sanity check: `node api/_numerology.js`
if (require.main === module) {
  const samples = [
    '2026-04-25T07:32:00Z', // 14:32 BKK, Saturday → ดาวเสาร์, pair_middle=43
    '2026-04-26T17:00:00Z', // 00:00 next BKK day, Monday → ดาวจันทร์, pair_middle=00
    '2026-04-24T16:30:00Z', // 23:30 BKK, Friday → ดาวศุกร์, pair_middle=33
  ];
  for (const s of samples) {
    console.log(s, '→', numerologyFromOpenTime(s));
  }
}
