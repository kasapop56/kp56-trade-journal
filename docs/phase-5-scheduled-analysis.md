# Phase 5 — Scheduled Market Analysis

**Status:** ✅ Live as of 2026-04-28. End-to-end pipeline verified. 3 routines scheduled.

## Live components

| Layer | Status |
|---|---|
| `mt5/TG Helper.txt` v5.20 dual-write | ✅ Compiled + reloaded on VPS, webhook ON |
| Vercel `/api/sitrep` ingest | ✅ Real SITREP id=2 captured 2026-04-27 21:00:01 Thai |
| Vercel `/api/sitrep-latest` read | ✅ Returns row + 16 recent_trades within 90-min window |
| Vercel `/api/post-plan` write | ✅ 3 plans posted to @Kp56_superbot DM (plan_id 1-3) |
| Supabase `market_sitreps` + `trade_plans` + `sitrep-images` bucket | ✅ All schemas applied, public-read working |
| 3 scheduled routines | ✅ Created, enabled, fire daily |

## Routine IDs

| Slot | Routine ID | Cron (UTC) | Manage |
|---|---|---|---|
| 09:00 Thai (Asian) | `trig_0196EizNk74VGhUUbDvV6dbn` | `0 2 * * *` | [link](https://claude.ai/code/routines/trig_0196EizNk74VGhUUbDvV6dbn) |
| 14:00 Thai (London) | `trig_01QZLbbPpfqo68UxC51zxxRm` | `0 7 * * *` | [link](https://claude.ai/code/routines/trig_01QZLbbPpfqo68UxC51zxxRm) |
| 21:00 Thai (NY) | `trig_01FrDLA34a1fH2PB6yfXRjpE` | `0 14 * * *` | [link](https://claude.ai/code/routines/trig_01FrDLA34a1fH2PB6yfXRjpE) |

Routine config: `claude-sonnet-4-6`, repo cloned (`kp56-trade-journal`), tools `[Bash, Read]`, env `Default` (`env_01M2KVvoPHdPnqPnagpst4bT`). Prompt template lives in this doc (see "Agent prompt template" below).

(Plus one disabled `smoke test` routine `trig_01Y3fLbw4Q2YrvmDaF5dL37P` — first-create test, never fires; safe to delete via web UI.)

## Original design notes

## TL;DR

Three times a day (Thai 09:00 / 14:00 / 21:00 = UTC 02 / 07 / 14) an Anthropic scheduled agent reads the latest hourly SITREP from the trade journal Supabase, fetches the chart screenshot, looks at recent closed trades, and posts a forward-looking trade plan to a separate Telegram group.

Source of truth = Supabase. The MT5 EA dual-writes every hourly SITREP — once to Telegram (existing behaviour) and once to a Vercel webhook that mirrors text + screenshot into Supabase. The cloud agent never touches the user's Mac or VPS directly.

## Why this architecture

**Telegram alone won't work.** A bot can't read its own outgoing messages via the Bot API (`getUpdates` only returns inbound). So we can't have the cloud agent "subscribe" to the existing TG Helper output. We need a parallel path.

**Mac local cron is off-limits.** macOS security has blocked local schedulers for the user repeatedly (see `feedback_no_local_cron.md`). All scheduling must run cloud-side.

**Supabase is already the journal's source of truth.** Mirroring SITREP data there reuses the existing `kp56-trade-journal` Vercel + Supabase stack. Pattern matches JournalSync (EA → Vercel webhook → Supabase).

## Pipeline

```
TG Helper EA (v5.2) on VPS
  ├──→ Telegram "Super Mario" group (chart PNG + SITREP text) ── existing
  └──→ POST /api/sitrep (Vercel)                              ── NEW
            │
            ├─ upload PNG → Supabase Storage "sitrep-images/<YYYY-MM-DD>/<unix_ts>.png"
            └─ parse SITREP → INSERT market_sitreps row

Anthropic scheduled agent (3 routines, cron 02/07/14 UTC)
  1. GET  /api/sitrep-latest (max_age_min=90, trades_hours=24)
  2. fetch image_url (public)
  3. analyse with vision
  4. POST /api/post-plan { sitrep_id, schedule_slot, full_text } ── NEW
            │
            ├─ Telegram sendMessage → analysis group (separate bot)
            └─ INSERT trade_plans row (history)
```

## What changed

### MT5 — `mt5/TG Helper.txt` v5.20

Two new inputs (blank by default = disabled, fully backwards-compatible):

```
InpSitrepWebhookURL    = ""   // e.g. https://kp56-trade-journal.vercel.app/api/sitrep
InpSitrepWebhookSecret = ""   // matches Vercel env SITREP_SHARED_SECRET
```

`ProcessAlertQueue()` deferred the Common-folder PNG cleanup so the new `SendSitrepWebhook()` can re-read the image bytes after the Telegram send. Webhook fires only when `[SCREENSHOT:...]` marker is present — i.e. SITREP messages only. Order alerts and hourly stats still go to Telegram only.

New helpers: `EscapeJsonString()`, `EncodeBase64()` (uses MQL5 `CryptEncode(CRYPT_BASE64, ...)`), `SendSitrepWebhook()` (multipart not needed — JSON with base64 image).

WebRequest target whitelist must be added in MT5: `Tools → Options → Expert Advisors → Allow WebRequest` → add the Vercel URL.

### Vercel — three new endpoints

| File | Purpose | Auth header |
|---|---|---|
| `api/sitrep.js` | Ingest from TG Helper. Decodes base64 PNG → Storage. Parses SITREP text → typed columns + raw fallback. | `X-Sitrep-Secret` |
| `api/sitrep-latest.js` | Cloud agent reads latest sitrep + recent closed trades. Returns 409 if newest sitrep older than `max_age_min`. | `X-Agent-Key` |
| `api/post-plan.js` | Cloud agent posts plan to Telegram + records in `trade_plans`. Telegram-first: DB insert only after Telegram succeeds. | `X-Agent-Key` |

`vercel.json` registered all three (max 10–15s).

### Supabase — `supabase_schema_phase5.sql`

- `market_sitreps` table — typed columns for fast filtering + `raw_text` + `image_url` fallback. Zone arrays as `jsonb`.
- `trade_plans` table — agent outputs, FK to source sitrep.
- `sitrep-images` Storage bucket — public read (so agent can fetch image without auth).
- Idempotent (`if not exists`), safe to re-run.

### SITREP text parser (in `api/sitrep.js`)

Permissive: every field is independently regex-matched and falls through to `null` on miss. Zone parser handles `[T1:70] M15 Tested BOS 4686.48-4691.96 (1474 pts) XAUUSDr` lines and an optional tags line below. Block separator `---` or section header `DEMAND` / `SUPPLY` ends a block. `none` inside a block → `[]`. HTML tags from `parse_mode=HTML` are stripped before matching.

## Schema sketch

```sql
market_sitreps (
  id, created_at, source='tg_helper', symbol, session,        -- "LONDON" / "NY" / "ASIAN"
  price, bias_m5, bias_m15,                                    -- Mario v5 bias
  ob_summary, zones_count, htf_conf, h1_count,
  vp_position, poc, vah, val, ppoc, pvah, pval,                -- volume profile
  supply_zones jsonb, demand_zones jsonb,                      -- [{tier, score, type, lo, hi, points, tags[]}]
  raw_text, image_url, image_path
)
trade_plans (
  id, created_at, sitrep_id→market_sitreps, schedule_slot,
  bias_call, summary, full_text, telegram_msg_id, telegram_chat
)
```

## Files

| File | Status |
|---|---|
| `supabase_schema_phase5.sql` | ✅ written — apply via Supabase SQL Editor |
| `api/sitrep.js` | ✅ written |
| `api/sitrep-latest.js` | ✅ written |
| `api/post-plan.js` | ✅ written |
| `vercel.json` | ✅ updated (added 3 functions) |
| `mt5/TG Helper.txt` v5.20 | ✅ written — needs MT5 reload + WebRequest whitelist + 2 inputs |

## Vercel env vars (all new, set before deploy)

| Var | Origin |
|---|---|
| `SITREP_SHARED_SECRET` | random long string — paste into TG Helper input too |
| `AGENT_READ_KEY` | random long string — given to scheduled agent for read endpoint |
| `AGENT_WRITE_KEY` | random long string — given to scheduled agent for post-plan endpoint |
| `TELEGRAM_PLAN_BOT_TOKEN` | from `@BotFather` (new bot for the analysis group) |
| `TELEGRAM_PLAN_CHAT_ID` | chat_id of the empty group (from `getUpdates` after sending one message) |

(`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` already exist from Phase 2.)

## Deploy steps (in order)

1. **Apply Supabase schema** — paste `supabase_schema_phase5.sql` into SQL Editor, run.
2. **Push code to GitHub** — Vercel auto-deploys. Confirm 3 new functions appear in dashboard.
3. **Set Vercel env vars** (all 5 above), redeploy if needed.
4. **In MT5: add Vercel URL to WebRequest whitelist** — Tools → Options → Expert Advisors → "Allow WebRequest for listed URL" → add `https://<project>.vercel.app`.
5. **Update TG Helper inputs** on running EA: `InpSitrepWebhookURL` + `InpSitrepWebhookSecret` (matches step 3). Save → EA reloads.
6. **Wait for next hourly SITREP** (or push manually via existing TEST TG button — it goes through the same queue path) → verify Supabase row appears.
7. **Create new Telegram bot + group**:
   - `@BotFather` → `/newbot` → save token
   - Add bot to the empty group (must be admin to post)
   - Send any message in group → fetch `https://api.telegram.org/bot<TOKEN>/getUpdates` → grab `result[].message.chat.id` (negative for groups)
8. **Set `TELEGRAM_PLAN_BOT_TOKEN` + `TELEGRAM_PLAN_CHAT_ID`** in Vercel, redeploy.
9. **Test `/api/post-plan` manually with curl** to confirm group delivery.
10. **Create 3 scheduled routines** via `/schedule` (cron `0 2 * * *`, `0 7 * * *`, `0 14 * * *`).

## Verification checklist

### Ingest path (steps 1–6 above)
- [ ] Schema applied — `select * from market_sitreps limit 0;` succeeds in SQL Editor
- [ ] Vercel build green, 4 API functions listed (ingest + 3 new)
- [ ] EA boot banner shows `🌐 SITREP webhook: ON`
- [ ] One hourly SITREP appears in Telegram (sanity)
- [ ] Same SITREP appears as a row in `market_sitreps` within ~5 sec
- [ ] `image_url` returns a valid PNG when opened in browser
- [ ] `bias_m5`, `bias_m15`, `price`, `vp_position`, `poc/vah/val`, `supply_zones` all parsed (not all null)
- [ ] EA Experts log shows `✅ SITREP webhook OK (...)`

### Output path (steps 7–10 above)
- [ ] Manual curl to `/api/post-plan` posts to new group
- [ ] `trade_plans` row created with correct `telegram_msg_id`
- [ ] One scheduled routine fires on time, posts a plan, plan visible in group

### End-to-end (after first scheduled fire)
- [ ] Plan references the actual SITREP price/bias/zones (not hallucinated)
- [ ] Plan references at least one recent closed trade if any in window
- [ ] If no SITREP in last 90 min, agent gracefully reports "no recent sitrep" instead of inventing data

## Open questions / future work

- **Stale-data fallback.** `/api/sitrep-latest` returns 409 if newest sitrep older than 90 min. Agent should explicitly say "no fresh data, skipping plan" rather than fabricate. Wording lives in the routine prompt, not in code.
- **Image expiry.** Free Supabase Storage tier holds ~1 GB. At 24 SITREPs/day × ~100 KB each ≈ 870 MB/year. Add a monthly cleanup routine (`delete from market_sitreps where created_at < now() - interval '90 days'` + remove orphaned objects) once we have data on actual size.
- **Plan replay.** `trade_plans` keeps every posted plan. Future UI: surface in trade-journal web for backtesting plan accuracy vs subsequent price action.
- **Multi-symbol.** If user starts trading non-XAUUSDr regularly, SITREP currently keys by `symbol` but the scheduled prompt assumes XAUUSDr. Revisit.
- **Image vision cost.** Each scheduled call fetches + analyses a ~100 KB PNG. 3/day × 365 ≈ 1100 calls/year — cheap. Note for future budgeting.

## Related files

- `mt5/TG Helper.txt` v5.20 — dual-write logic
- `api/sitrep.js`, `api/sitrep-latest.js`, `api/post-plan.js` — Vercel endpoints
- `supabase_schema_phase5.sql` — schema
- `docs/phase-3c-rainbow-context.md` — sister phase: trade-time context capture
- `docs/phase-4-auto-sltp.md` — sister phase: discipline enforcement
