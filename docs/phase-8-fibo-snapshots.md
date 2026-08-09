# Phase 8 — Fibo Focus Snapshots

Record every "กรอบใหม่" the **Fibo Focus Zone [B/S]** Pine indicator draws, ping
Telegram, and keep a browsable log in the journal. **Snapshot only — no Win/Loss
tracking yet.**

## Flow

```
Pine (FiboFocusSignals.pine)
  └─ alert() JSON on each new frame (seq resets daily)
        │ TradingView webhook
        ▼
  POST /api/fibo-snapshot   ── auth: body.secret == FIBO_WEBHOOK_SECRET
        ├─ insert → Supabase  fibo_snapshots
        └─ Telegram  "🟧 Fibo Focus — วาดใหม่ … Seq #N"
        ▼
  Journal UI  → tab "Fibo 🎯"  (reads fibo_snapshots via anon key)
```

## Files

| Piece      | Path                                  |
|------------|---------------------------------------|
| Pine       | `../FiboFocusSignals.pine` (KP56 root, indicator ⑥ Alert/Webhook) |
| Schema     | `supabase_schema_fibo.sql`            |
| Webhook    | `api/fibo-snapshot.js` (+ `vercel.json`) |
| UI page    | `js/fibo.js`, `#fibo` in `index.html`, `.fibo-*` in `css/style.css` |

## Deploy checklist

1. **Supabase** — run `supabase_schema_fibo.sql` in the SQL editor (creates
   `fibo_snapshots` + anon read policy).
2. **Vercel env vars** (Project → Settings → Environment Variables):
   - `FIBO_WEBHOOK_SECRET` — pick any string; must match the Pine input.
   - *(optional)* `FIBO_TELEGRAM_CHAT_ID` / `FIBO_TELEGRAM_BOT_TOKEN` to send to a
     different chat/bot. If unset, reuses `TELEGRAM_PLAN_*`. Set
     `FIBO_TELEGRAM_CHAT_ID=off` to skip Telegram entirely.
   - `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` already exist.
3. **Deploy** — `git push` (auto-deploys, per project rule — never `vercel --prod`).
4. **TradingView**:
   - Add the indicator to an XAUUSD chart. In settings ⑥ set **Webhook secret** =
     the same `FIBO_WEBHOOK_SECRET`.
   - Create an alert: Condition = *Fibo Focus Zone*, **Once Per Bar Close**,
     Webhook URL = `https://<journal-domain>/api/fibo-snapshot`.
   - Leave the alert message as `{{...}}`? **No** — the indicator builds the full
     JSON itself via `alert()`, so the alert "message" box is ignored; just enable
     the webhook. (Requires a TradingView plan with webhooks.)

## Data contract (JSON body)

`secret, symbol, tf, seq, frame_no, entry_mode, zone_pts, price, bar_time,`
`fh, fl, mid, s_focus, s_test, s_tp1, s_tp3, s_sl, b_focus, b_test, b_tp1, b_tp3, b_sl`

`seq` resets to 1 each new trading day; `frame_no` is a monotonic per-chart counter.
The whole payload is also stored in `fibo_snapshots.raw` (jsonb) for future fields.

## Phase 8b — Win/Loss tracking

Pine now runs a per-side state machine and fires lifecycle events through the SAME
webhook (routed by a `type` field):

- **ENTER** — price reached the entry zone. `Test 1.272` = bar **closes** inside the
  ±zone; `Focus 2.0` = price **touches** the zone edge (extension spike/wick).
- **WIN** — TP1 (500p) hit before SL.  **LOSS** — SL hit before TP1.
- **VOID / no-entry** is not emitted; the UI infers it (a frame side with no ENTER
  once a newer frame exists).

Each event carries `type, frame_id, side (S/B), entry, tp1, sl, mfe`. `frame_id` =
the drawing bar's ms-epoch = `fibo_snapshots.bar_time` (the join key). `mfe` = max
favorable price since entry; the webhook maps it against the frame's TP ladder to
report "best TP reached".

**⚠️ Runs on the chart TF = calc TF (M15).** Keep the alert on an M15 XAUUSD chart
for accurate touch detection. Tie-break: if a bar hits both TP1 and SL, counts LOSS.

### Extra files (8b)
| Piece   | Path |
|---------|------|
| Schema  | `supabase_schema_fibo_events.sql` (table `fibo_events`) |
| Pine    | indicator group ⑦ Win/Loss tracking (`alWL`) |
| Backend | `api/fibo-snapshot.js` branches `type` → `handleEvent` |
| UI      | `js/fibo.js` merges events → per-side badge + daily W/L bar |

### Deploy (8b)
1. Run `supabase_schema_fibo_events.sql` in Supabase.
2. `git push` (redeploys the webhook + UI).
3. The existing TradingView alert already covers it — "Any alert() function call"
   forwards every `alert()` (snapshot + events) to the same webhook. No new alert
   needed. (Keep the alert on an M15 chart.)

## Not done yet (later)

- Partial-close / scale-out modeling (currently binary TP1 vs SL, with best-TP as a
  secondary stat).
- Per-session / per-day-star W/L breakdowns.
