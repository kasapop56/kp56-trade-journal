// Vercel webhook — receives hourly SITREP from TG Helper EA (v5.2+).
//
// Endpoint:  POST /api/sitrep
// Headers:   Content-Type: application/json
//            X-Sitrep-Secret: <SITREP_SHARED_SECRET>
//
// Body (JSON):
//   {
//     symbol:         "XAUUSDr",
//     screenshot_tag: "HOURLY|LONDON",   // from [SCREENSHOT:...] marker
//     raw_text:       "...full SITREP message...",
//     image_b64:      "<base64 PNG>",    // optional; omit if no screenshot
//     captured_at:    "2026-04-27T07:00:00Z"  // optional; defaults to now()
//   }
//
// Side effects:
//   1. If image_b64 provided → upload to Supabase Storage bucket "sitrep-images"
//      at path "<YYYY-MM-DD>/<unix_ts>.png" → public URL.
//   2. Parse raw_text into structured columns (price, bias, vp_position, zones).
//   3. Insert row into market_sitreps.
//
// Env vars (Vercel → Project → Settings → Environment Variables):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   SITREP_SHARED_SECRET

const { createClient } = require('@supabase/supabase-js');

let _supabase;
function getClient() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars');
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

function bad(res, code, msg) {
  res.status(code).json({ ok: false, error: msg });
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

// ─── SITREP text parser ──────────────────────────────────────────────────
// Strips HTML tags (TG Helper sends parse_mode=HTML so message may contain
// <b>...</b> wrappers around field labels) before regex matching. We keep the
// parser permissive — anything that doesn't match becomes null and the agent
// falls back to raw_text.

function stripHtml(s) {
  return s.replace(/<\/?[a-z][^>]*>/gi, '');
}

function num(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function intOrNull(s) {
  if (s == null) return null;
  const n = parseInt(String(s), 10);
  return Number.isFinite(n) ? n : null;
}

function matchOne(text, re) {
  const m = text.match(re);
  return m ? m[1] : null;
}

function parseSitrep(rawText) {
  const text = stripHtml(rawText || '');
  const lines = text.split(/\r?\n/);

  const out = {
    price:        num(matchOne(text, /Price:\s*([\d.]+)/i)),
    bias_m15:     matchOne(text, /Bias:\s*(\w+)\s*\(M15\)/i),
    bias_m5:      matchOne(text, /\b(\w+)\s*\(M5\)/i),
    ob_summary:   matchOne(text, /OB:\s*([^\s|]+)/i),
    zones_count:  intOrNull(matchOne(text, /Zones:\s*(\d+)/i)),
    htf_conf:     intOrNull(matchOne(text, /HTF_Conf:\s*(\d+)/i)),
    h1_count:     intOrNull(matchOne(text, /\bH1:\s*(\d+)/i)),
    vp_position:  matchOne(text, /Position:\s*([^\n]+)/i)?.trim() || null,
    poc:          num(matchOne(text, /\bPOC:\s*([\d.]+)/i)),
    vah:          num(matchOne(text, /\bVAH:\s*([\d.]+)/i)),
    val:          num(matchOne(text, /\bVAL:\s*([\d.]+)/i)),
    ppoc:         num(matchOne(text, /\bpPOC:\s*([\d.]+)/i)),
    pvah:         num(matchOne(text, /\bpVAH:\s*([\d.]+)/i)),
    pval:         num(matchOne(text, /\bpVAL:\s*([\d.]+)/i)),
    supply_zones: parseZoneBlock(lines, /SUPPLY/i, /DEMAND/i),
    demand_zones: parseZoneBlock(lines, /DEMAND/i, null),
  };
  return out;
}

// Parse one zone block: collect lines between startRe and endRe (or EOF),
// then group every (header, tags) pair into a zone object.
//
// Header line example:    [T1:70] M15 Tested BOS 4686.48-4691.96 (1474 pts) XAUUSDr
// Tags line example:        VAL+BOS+M15+Def:6
//
// Lines reading "none" (case-insensitive) inside a block → empty array.
function parseZoneBlock(lines, startRe, endRe) {
  let started = false;
  const block = [];
  for (const ln of lines) {
    if (!started) {
      if (startRe.test(ln)) started = true;
      continue;
    }
    if (endRe && endRe.test(ln)) break;
    if (/^-+$/.test(ln.trim())) break;          // separator line ends block
    if (ln.trim()) block.push(ln);
  }
  if (block.length === 0) return [];
  if (block.length === 1 && /^\s*none\s*$/i.test(block[0])) return [];

  const zones = [];
  const headerRe = /\[(T\d+|S):\s*(\d+)\]\s*(.+?)\s+([\d.]+)\s*-\s*([\d.]+)\s*\(\s*(\d+)\s*pts?\s*\)\s*(\S+)?/i;

  for (let i = 0; i < block.length; i++) {
    const m = block[i].match(headerRe);
    if (!m) continue;
    const zone = {
      tier:   m[1],                              // "T1" or "S"
      score:  parseInt(m[2], 10),
      type:   m[3].trim(),                       // "M15 Tested BOS"
      lo:     parseFloat(m[4]),
      hi:     parseFloat(m[5]),
      points: parseInt(m[6], 10),
      symbol: m[7] || null,
      tags:   [],
    };
    // Look ahead for tags line (next line that's NOT a header)
    if (i + 1 < block.length && !headerRe.test(block[i + 1])) {
      zone.tags = block[i + 1].trim().split(/\s*\+\s*/).filter(Boolean);
      i++;
    }
    zones.push(zone);
  }
  return zones;
}

function sessionFromTag(tag) {
  if (!tag) return null;
  // "HOURLY|LONDON" → "LONDON"
  const parts = String(tag).split('|');
  return parts[parts.length - 1].trim().toUpperCase() || null;
}

// ─── Handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== 'POST') return bad(res, 405, 'method_not_allowed');

  const expected = process.env.SITREP_SHARED_SECRET;
  if (!expected) return bad(res, 500, 'server_missing_secret');
  if (req.headers['x-sitrep-secret'] !== expected) return bad(res, 401, 'bad_secret');

  let payload;
  try { payload = await readJson(req); }
  catch (e) { return bad(res, 400, 'invalid_json: ' + e.message); }

  if (!payload.raw_text) return bad(res, 400, 'missing_field: raw_text');

  const db = getClient();

  // Upload image if provided
  let imageUrl = null;
  let imagePath = null;
  if (payload.image_b64) {
    try {
      const buf = Buffer.from(payload.image_b64, 'base64');
      const now = new Date();
      const ymd = now.toISOString().slice(0, 10);          // YYYY-MM-DD
      const fname = `${now.getTime()}.png`;
      imagePath = `${ymd}/${fname}`;

      const { error: upErr } = await db.storage
        .from('sitrep-images')
        .upload(imagePath, buf, {
          contentType: 'image/png',
          cacheControl: '3600',
          upsert: false,
        });
      if (upErr) return bad(res, 500, 'storage_error: ' + upErr.message);

      const { data: pub } = db.storage.from('sitrep-images').getPublicUrl(imagePath);
      imageUrl = pub?.publicUrl || null;
    } catch (e) {
      return bad(res, 400, 'invalid_image_b64: ' + e.message);
    }
  }

  const parsed = parseSitrep(payload.raw_text);

  const row = {
    source:       'tg_helper',
    symbol:       payload.symbol || null,
    session:      sessionFromTag(payload.screenshot_tag),
    raw_text:     payload.raw_text,
    image_url:    imageUrl,
    image_path:   imagePath,
    ...parsed,
  };
  if (payload.captured_at) row.created_at = payload.captured_at;

  const { data, error } = await db
    .from('market_sitreps')
    .insert(row)
    .select('id, created_at, image_url')
    .single();
  if (error) return bad(res, 500, 'db_error: ' + error.message);

  return res.status(200).json({
    ok: true,
    id: data.id,
    created_at: data.created_at,
    image_url: data.image_url,
    parsed_fields: Object.keys(parsed).filter(k => parsed[k] != null && (!Array.isArray(parsed[k]) || parsed[k].length > 0)).length,
  });
};
