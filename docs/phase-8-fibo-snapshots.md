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

## Not done yet (next phase)

- Win/Loss outcome tracking (Pine fires a second alert when price hits TP1/SL of an
  active frame → `fibo_outcomes` table + per-day W/L on the UI).
