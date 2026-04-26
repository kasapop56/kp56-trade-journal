//+------------------------------------------------------------------+
//|                                                  JournalSync.mq5 |
//|   Sends closed trades + periodic balance snapshots to the KP56   |
//|   trade journal webhook. Zero credentials leave the VPS.         |
//|                                                                  |
//|   v1.10 (Phase 3c) — Rainbow MA context capture at OPEN + CLOSE. |
//|     • DEAL_ENTRY_IN  → snapshot RAINBOW_* GVs to a position-     |
//|       keyed file in Files\Common so it survives the gap until    |
//|       the position closes.                                       |
//|     • DEAL_ENTRY_OUT → read that file + snapshot current GVs as  |
//|       close-state, both shipped in the trade_closed payload.     |
//+------------------------------------------------------------------+
#property copyright "KP56"
#property version   "1.10"
#property strict

// ── Inputs ─────────────────────────────────────────────────────────
input string  WebhookURL            = "https://kp56-trade-journal.vercel.app/api/ingest";
input string  SharedSecret          = "CHANGE_ME_TO_MATCH_VERCEL_ENV";
input int     BalanceIntervalMin    = 60;     // balance snapshot cadence
input string  SymbolFilter          = "";     // e.g. "XAUUSDr" — empty = all symbols
input long    MagicFilter           = 0;      // 0 = all magics
input int     WebRequestTimeoutMs   = 5000;
input bool    SendBalanceOnClose    = true;   // extra snapshot right after each close
input bool    VerboseLogs           = true;
input int     MarioStateMaxAgeSec   = 300;    // ignore Mario context older than this
input int     RainbowStateMaxAgeSec = 300;    // ignore RainbowMA context older than this

// ── State ──────────────────────────────────────────────────────────
datetime g_last_balance_sent = 0;
long     g_account_login     = 0;

//+------------------------------------------------------------------+
int OnInit()
{
   g_account_login = (long)AccountInfoInteger(ACCOUNT_LOGIN);

   if(StringLen(SharedSecret) < 12 || SharedSecret == "CHANGE_ME_TO_MATCH_VERCEL_ENV")
   {
      Print("[JournalSync] ERROR: SharedSecret is not set. Configure it in EA inputs.");
      return(INIT_PARAMETERS_INCORRECT);
   }
   if(StringFind(WebhookURL, "https://") != 0)
   {
      Print("[JournalSync] ERROR: WebhookURL must start with https://");
      return(INIT_PARAMETERS_INCORRECT);
   }

   // OnTimer fires every 60s; we gate inside to hit the BalanceIntervalMin cadence.
   EventSetTimer(60);

   // Fire an initial snapshot so the dashboard has a data point immediately.
   SendBalanceSnapshot();

   Print("[JournalSync] initialized — account ", g_account_login,
         " symbolFilter='", SymbolFilter, "' magicFilter=", MagicFilter,
         " balanceEvery=", BalanceIntervalMin, "min");
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
}

//+------------------------------------------------------------------+
void OnTimer()
{
   if(BalanceIntervalMin <= 0) return;
   datetime now = TimeCurrent();
   if(g_last_balance_sent == 0 || (now - g_last_balance_sent) >= BalanceIntervalMin * 60)
      SendBalanceSnapshot();
}

//+------------------------------------------------------------------+
//| OnTradeTransaction fires on every trade event. We act on:        |
//|   • DEAL_ENTRY_IN          — write rainbow_open snapshot file    |
//|   • DEAL_ENTRY_OUT/OUT_BY  — POST trade_closed payload           |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction& trans,
                        const MqlTradeRequest&      request,
                        const MqlTradeResult&       result)
{
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD) return;
   ulong deal = trans.deal;
   if(deal == 0) return;

   // Pull deal details from history (must be inside the history window).
   if(!HistorySelect(TimeCurrent() - 7*86400, TimeCurrent() + 86400))
      return;
   if(!HistoryDealSelect(deal))
      return;

   long entry = HistoryDealGetInteger(deal, DEAL_ENTRY);

   string sym = HistoryDealGetString(deal, DEAL_SYMBOL);
   if(StringLen(SymbolFilter) > 0 && sym != SymbolFilter) return;

   long magic = HistoryDealGetInteger(deal, DEAL_MAGIC);
   if(MagicFilter != 0 && magic != MagicFilter) return;

   if(entry == DEAL_ENTRY_IN)
   {
      long pos_id = HistoryDealGetInteger(deal, DEAL_POSITION_ID);
      RainbowWriteOpenSnapshot(pos_id);
      return;
   }

   if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY)
   {
      SendTradeClosed(deal);
      if(SendBalanceOnClose)
         SendBalanceSnapshot();
      return;
   }
}

//+------------------------------------------------------------------+
//| Build + POST the trade_closed payload. Pairs the closing deal    |
//| with its corresponding opening deal from the same position_id to |
//| recover open price + open time.                                   |
//+------------------------------------------------------------------+
void SendTradeClosed(ulong close_deal)
{
   long   position_id = HistoryDealGetInteger(close_deal, DEAL_POSITION_ID);
   string symbol      = HistoryDealGetString(close_deal, DEAL_SYMBOL);
   long   deal_type   = HistoryDealGetInteger(close_deal, DEAL_TYPE);
   double volume      = HistoryDealGetDouble(close_deal, DEAL_VOLUME);
   datetime close_t   = (datetime)HistoryDealGetInteger(close_deal, DEAL_TIME);
   double close_px    = HistoryDealGetDouble(close_deal, DEAL_PRICE);
   double sl          = HistoryDealGetDouble(close_deal, DEAL_SL);
   double tp          = HistoryDealGetDouble(close_deal, DEAL_TP);
   double profit      = HistoryDealGetDouble(close_deal, DEAL_PROFIT);
   double swap        = HistoryDealGetDouble(close_deal, DEAL_SWAP);
   double commission  = HistoryDealGetDouble(close_deal, DEAL_COMMISSION);
   long   magic       = HistoryDealGetInteger(close_deal, DEAL_MAGIC);
   string comment     = HistoryDealGetString(close_deal, DEAL_COMMENT);

   // The closing deal's DEAL_TYPE is the reverse of the original position direction:
   // closing a BUY uses DEAL_TYPE_SELL and vice versa. Flip it to recover intent.
   string type_str = (deal_type == DEAL_TYPE_SELL) ? "buy" : "sell";

   // Find the opening deal for this position. HistorySelectByPosition is the
   // canonical way — it loads every deal tied to this position_id regardless
   // of when it was opened. More reliable than a time-window HistorySelect.
   datetime open_t   = 0;
   double   open_px  = 0.0;
   if(HistorySelectByPosition(position_id))
   {
      int total = HistoryDealsTotal();
      for(int i = 0; i < total; i++)
      {
         ulong tk = HistoryDealGetTicket(i);
         if(tk == 0) continue;
         if(HistoryDealGetInteger(tk, DEAL_ENTRY) != DEAL_ENTRY_IN) continue;
         open_t  = (datetime)HistoryDealGetInteger(tk, DEAL_TIME);
         open_px = HistoryDealGetDouble(tk, DEAL_PRICE);
         break;
      }
   }
   // Last-resort fallback if the opening deal is somehow unavailable — use
   // close values so the record is non-null and at least captures the close.
   if(open_t == 0)  { open_t = close_t;  Print("[JournalSync] WARN: opening deal not found for pos ", position_id, " — using close_time as open_time"); }
   if(open_px == 0) { open_px = close_px; }

   double bal = AccountInfoDouble(ACCOUNT_BALANCE);
   double eq  = AccountInfoDouble(ACCOUNT_EQUITY);

   // Pull Mario v5 indicator state (Phase 3b). Mario writes MARIO_* GVs every
   // tick; we snapshot whatever's there at the moment this close fires. Stale
   // state (Mario crashed or chart closed) is dropped via MarioStateMaxAgeSec.
   string mario_json = MarioContextJsonFragment();

   // Pull Rainbow MA context (Phase 3c) — open from per-position snapshot
   // file written at DEAL_ENTRY_IN, close from current RAINBOW_* GVs. If the
   // open file is missing (EA reloaded mid-position, etc.), substitute the
   // explicit 'none' fragment so columns are null rather than missing.
   string rainbow_open_json  = RainbowReadOpenSnapshot(position_id);
   if(StringLen(rainbow_open_json) == 0)
      rainbow_open_json = RainbowEmptyFragment("open");
   string rainbow_close_json = RainbowFragment("close");
   RainbowDeleteOpenSnapshot(position_id);

   // Build JSON
   string json = "{";
   json += "\"event\":\"trade_closed\",";
   json += "\"account_login\":" + IntegerToString(g_account_login) + ",";
   json += "\"deal_ticket\":"   + IntegerToString((long)close_deal) + ",";
   json += "\"position_id\":"   + IntegerToString(position_id) + ",";
   json += "\"symbol\":\""      + JsonEscape(symbol) + "\",";
   json += "\"type\":\""        + type_str + "\",";
   json += "\"volume\":"        + DoubleToString(volume, 2) + ",";
   json += "\"open_time\":\""   + TimeToISO8601UTC(open_t)  + "\",";
   json += "\"close_time\":\""  + TimeToISO8601UTC(close_t) + "\",";
   json += "\"open_price\":"    + DoubleToString(open_px, 5) + ",";
   json += "\"close_price\":"   + DoubleToString(close_px, 5) + ",";
   json += "\"sl\":"            + ((sl > 0) ? DoubleToString(sl, 5) : "null") + ",";
   json += "\"tp\":"            + ((tp > 0) ? DoubleToString(tp, 5) : "null") + ",";
   json += "\"profit\":"        + DoubleToString(profit, 2) + ",";
   json += "\"swap\":"          + DoubleToString(swap, 2) + ",";
   json += "\"commission\":"    + DoubleToString(commission, 2) + ",";
   json += "\"magic\":"         + IntegerToString(magic) + ",";
   json += "\"comment\":\""     + JsonEscape(comment) + "\",";
   json += "\"balance_after\":" + DoubleToString(bal, 2) + ",";
   json += "\"equity_after\":"  + DoubleToString(eq, 2) + ",";
   json += mario_json;
   json += "," + rainbow_open_json;
   json += "," + rainbow_close_json;
   json += "}";

   int status = HttpPostJson(json);
   if(VerboseLogs)
      PrintFormat("[JournalSync] trade_closed deal=%I64u pos=%I64d %s %s %.2f lots profit=%.2f → HTTP %d",
                  close_deal, position_id, type_str, symbol, volume, profit, status);
}

//+------------------------------------------------------------------+
void SendBalanceSnapshot()
{
   double bal       = AccountInfoDouble(ACCOUNT_BALANCE);
   double eq        = AccountInfoDouble(ACCOUNT_EQUITY);
   double margin    = AccountInfoDouble(ACCOUNT_MARGIN);
   double freeMargin= AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   double mLevel    = AccountInfoDouble(ACCOUNT_MARGIN_LEVEL);
   int    openPos   = PositionsTotal();

   string json = "{";
   json += "\"event\":\"balance_snapshot\",";
   json += "\"account_login\":"  + IntegerToString(g_account_login) + ",";
   json += "\"balance\":"        + DoubleToString(bal, 2) + ",";
   json += "\"equity\":"         + DoubleToString(eq, 2) + ",";
   json += "\"margin\":"         + DoubleToString(margin, 2) + ",";
   json += "\"free_margin\":"    + DoubleToString(freeMargin, 2) + ",";
   json += "\"margin_level\":"   + ((margin > 0) ? DoubleToString(mLevel, 2) : "null") + ",";
   json += "\"open_positions\":" + IntegerToString(openPos) + ",";
   json += "\"recorded_at\":\""  + TimeToISO8601UTC(TimeCurrent()) + "\"";
   json += "}";

   int status = HttpPostJson(json);
   if(status >= 200 && status < 300)
      g_last_balance_sent = TimeCurrent();

   if(VerboseLogs)
      PrintFormat("[JournalSync] balance_snapshot bal=%.2f eq=%.2f open=%d → HTTP %d",
                  bal, eq, openPos, status);
}

//+------------------------------------------------------------------+
//| HTTPS POST using MT5 WebRequest. Returns HTTP status, or         |
//| -1 on transport error (e.g. URL not whitelisted).                 |
//+------------------------------------------------------------------+
int HttpPostJson(const string body)
{
   char   data[];
   char   result[];
   string result_headers;
   string headers = "Content-Type: application/json\r\n"
                  + "X-Journal-Secret: " + SharedSecret + "\r\n";

   StringToCharArray(body, data, 0, StringLen(body), CP_UTF8);
   // Trim trailing null from StringToCharArray
   if(ArraySize(data) > 0 && data[ArraySize(data)-1] == 0)
      ArrayResize(data, ArraySize(data)-1);

   ResetLastError();
   int status = WebRequest("POST", WebhookURL, headers, WebRequestTimeoutMs,
                           data, result, result_headers);

   if(status == -1)
   {
      int err = GetLastError();
      PrintFormat("[JournalSync] WebRequest failed: error=%d. "
                  "Did you whitelist the URL in Tools → Options → Expert Advisors?", err);
      return -1;
   }
   if(status < 200 || status >= 300)
   {
      string resp = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
      PrintFormat("[JournalSync] HTTP %d response: %s", status, resp);
   }
   return status;
}

//+------------------------------------------------------------------+
//| Convert broker-server datetime to ISO 8601 UTC.                  |
//| MT5 stores datetimes as "seconds since 1970" but broker values   |
//| carry the broker's TZ offset; subtract it to get real UTC.        |
//+------------------------------------------------------------------+
string TimeToISO8601UTC(datetime broker_time)
{
   if(broker_time == 0) return "";
   int offset = (int)(TimeTradeServer() - TimeGMT()); // broker offset in seconds
   datetime utc = broker_time - offset;
   MqlDateTime st;
   TimeToStruct(utc, st);
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02dZ",
                       st.year, st.mon, st.day, st.hour, st.min, st.sec);
}

//+------------------------------------------------------------------+
//| Minimal JSON string escape — the only fields that can carry user |
//| content are symbol + comment, both short and ASCII in practice.   |
//+------------------------------------------------------------------+
string JsonEscape(string s)
{
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   StringReplace(s, "\n", "\\n");
   StringReplace(s, "\r", "\\r");
   StringReplace(s, "\t", "\\t");
   return s;
}

//+------------------------------------------------------------------+
//| Mario context capture (Phase 3b) — read MARIO_* GlobalVariables  |
//| set by the indicator and emit JSON fragment for the trade_closed |
//| payload. Encoding contract documented in trade-journal/mt5/      |
//| Mario.mq5 above MarioJournal_PublishState().                      |
//+------------------------------------------------------------------+
double MarioGV(const string name)
{
   return GlobalVariableCheck(name) ? GlobalVariableGet(name) : 0.0;
}

string MarioBiasStr(double v)
{
   if(v > 0.5)  return "BULL";
   if(v < -0.5) return "BEAR";
   return "NEUT";
}

string MarioSessionStr(int v)
{
   switch(v)
   {
      case 1: return "ASIA";
      case 2: return "LONDON";
      case 3: return "OVERLAP";
      case 4: return "NY";
      default: return "QUIET";
   }
}

string MarioDecisionStr(int v)
{
   switch(v)
   {
      case 0: return "GO";
      case 1: return "WARN";
      case 2: return "WAIT";
      case 3: return "SKIP";
      default: return "SKIP";
   }
}

string MarioOBStatusStr(int tier, int type, int score, bool inOpp)
{
   if(tier <= 0)
      return inOpp ? "in opposite zone" : "no zone";
   string tierLbl;
   switch(tier)
   {
      case 1: tierLbl = "S";  break;
      case 2: tierLbl = "T1"; break;
      case 3: tierLbl = "T2"; break;
      case 4: tierLbl = "T3"; break;
      default: tierLbl = "?";
   }
   string typeLbl = (type == 1) ? "Demand" : (type == 2 ? "Supply" : "?");
   return StringFormat("%s %s (%d)", typeLbl, tierLbl, score);
}

string MarioContextJsonFragment()
{
   double ts = MarioGV("MARIO_STATE_TS");
   if(ts <= 0 || (TimeCurrent() - (datetime)(long)ts) > MarioStateMaxAgeSec)
   {
      // Stale or never-published — record an explicit miss. Keeps the row
      // honest about the gap rather than silently dropping the columns.
      return "\"capture_method\":\"none\","
             "\"bias_m15\":null,"
             "\"bias_m5\":null,"
             "\"ob_status\":null,"
             "\"svp_poc\":null,"
             "\"svp_vah\":null,"
             "\"svp_val\":null,"
             "\"mario_session\":null,"
             "\"mario_decision\":null";
   }

   string bias_m15 = MarioBiasStr(MarioGV("MARIO_BIAS_M15"));
   string bias_m5  = MarioBiasStr(MarioGV("MARIO_BIAS_M5"));

   int    obTier  = (int)MarioGV("MARIO_OB_TIER");
   int    obType  = (int)MarioGV("MARIO_OB_TYPE");
   int    obScore = (int)MarioGV("MARIO_OB_SCORE");
   bool   inOpp   = (MarioGV("MARIO_OB_INOPP") > 0.5);
   string ob      = MarioOBStatusStr(obTier, obType, obScore, inOpp);

   double poc = MarioGV("MARIO_SVP_POC");
   double vah = MarioGV("MARIO_SVP_VAH");
   double val = MarioGV("MARIO_SVP_VAL");

   string ses = MarioSessionStr((int)MarioGV("MARIO_SESSION"));
   string dec = MarioDecisionStr((int)MarioGV("MARIO_DECISION"));

   string s = "";
   s += "\"capture_method\":\"mario_gv\",";
   s += "\"bias_m15\":\""      + bias_m15 + "\",";
   s += "\"bias_m5\":\""       + bias_m5  + "\",";
   s += "\"ob_status\":\""     + JsonEscape(ob) + "\",";
   s += "\"svp_poc\":"         + ((poc > 0) ? DoubleToString(poc, 2) : "null") + ",";
   s += "\"svp_vah\":"         + ((vah > 0) ? DoubleToString(vah, 2) : "null") + ",";
   s += "\"svp_val\":"         + ((val > 0) ? DoubleToString(val, 2) : "null") + ",";
   s += "\"mario_session\":\"" + ses + "\",";
   s += "\"mario_decision\":\""+ dec + "\"";
   return s;
}

//+------------------------------------------------------------------+
//| Rainbow MA context capture (Phase 3c) — read RAINBOW_* GVs set   |
//| by RainbowMA.mq5 (v1.30+). Encoding contract documented in       |
//| RainbowMA.mq5 above RainbowJournal_PublishState().                |
//|                                                                  |
//| Capture happens at TWO moments per position:                     |
//|   • OPEN  — DEAL_ENTRY_IN  → RainbowWriteOpenSnapshot() saves     |
//|             the JSON fragment to Files\Common\rainbow_open_<pos> |
//|             so it survives until the position closes.            |
//|   • CLOSE — DEAL_ENTRY_OUT → RainbowFragment("close") snapshots   |
//|             current GVs at the close moment.                     |
//+------------------------------------------------------------------+
double RainbowGV(const string name)
{
   return GlobalVariableCheck(name) ? GlobalVariableGet(name) : 0.0;
}

string RainbowCandleStr(int v)
{
   if(v > 0) return "green";
   if(v < 0) return "red";
   return "doji";
}

string RainbowOrderStr(int v)
{
   if(v > 0) return "BULL_STACK";
   if(v < 0) return "BEAR_STACK";
   return "MIXED";
}

string RainbowEmptyFragment(const string moment)
{
   string tags[4] = {"m1", "m5", "m15", "h1"};
   string s = "\"rainbow_capture_method_" + moment + "\":\"none\"";
   for(int t = 0; t < 4; t++)
   {
      string p = "rainbow_" + tags[t] + "_" + moment + "_";
      s += ",\"" + p + "slow_ma\":null";
      s += ",\"" + p + "close_price\":null";
      s += ",\"" + p + "band_idx\":null";
      s += ",\"" + p + "candle\":null";
      s += ",\"" + p + "body_points\":null";
      s += ",\"" + p + "order_state\":null";
   }
   return s;
}

string RainbowFragment(const string moment)
{
   double ts = RainbowGV("RAINBOW_STATE_TS");
   if(ts <= 0 || (TimeCurrent() - (datetime)(long)ts) > RainbowStateMaxAgeSec)
      return RainbowEmptyFragment(moment);

   string tagsHi[4] = {"M1",  "M5",  "M15",  "H1"};
   string tagsLo[4] = {"m1",  "m5",  "m15",  "h1"};

   string s = "\"rainbow_capture_method_" + moment + "\":\"rainbow_gv\"";
   for(int t = 0; t < 4; t++)
   {
      string pi = "RAINBOW_" + tagsHi[t] + "_";
      string po = "rainbow_" + tagsLo[t] + "_" + moment + "_";

      double slow_ma = RainbowGV(pi + "SLOW_MA");
      // SLOW_MA == 0 is the indicator's "TF not warmed up" sentinel.
      if(slow_ma <= 0.0)
      {
         s += ",\"" + po + "slow_ma\":null";
         s += ",\"" + po + "close_price\":null";
         s += ",\"" + po + "band_idx\":null";
         s += ",\"" + po + "candle\":null";
         s += ",\"" + po + "body_points\":null";
         s += ",\"" + po + "order_state\":null";
         continue;
      }

      double cprice = RainbowGV(pi + "CLOSE_PRICE");
      int    band   = (int)RainbowGV(pi + "BAND_IDX");
      int    candle = (int)RainbowGV(pi + "CANDLE");
      double body   = RainbowGV(pi + "BODY_POINTS");
      int    order  = (int)RainbowGV(pi + "ORDER");

      s += ",\"" + po + "slow_ma\":"      + DoubleToString(slow_ma, _Digits);
      s += ",\"" + po + "close_price\":"  + DoubleToString(cprice,  _Digits);
      s += ",\"" + po + "band_idx\":"     + IntegerToString(band);
      s += ",\"" + po + "candle\":\""     + RainbowCandleStr(candle) + "\"";
      s += ",\"" + po + "body_points\":"  + DoubleToString(body, 2);
      s += ",\"" + po + "order_state\":\""+ RainbowOrderStr(order) + "\"";
   }
   return s;
}

string RainbowSnapshotFilename(long position_id)
{
   return "rainbow_open_" + IntegerToString(position_id) + ".json";
}

void RainbowWriteOpenSnapshot(long position_id)
{
   string fragment = RainbowFragment("open");
   string fname    = RainbowSnapshotFilename(position_id);

   int h = FileOpen(fname, FILE_WRITE | FILE_TXT | FILE_COMMON | FILE_UNICODE);
   if(h == INVALID_HANDLE)
   {
      PrintFormat("[JournalSync] WARN: rainbow open snapshot write failed pos=%I64d err=%d",
                  position_id, GetLastError());
      return;
   }
   FileWriteString(h, fragment);
   FileClose(h);
   if(VerboseLogs)
      PrintFormat("[JournalSync] rainbow open snapshot saved pos=%I64d → %s",
                  position_id, fname);
}

string RainbowReadOpenSnapshot(long position_id)
{
   string fname = RainbowSnapshotFilename(position_id);
   if(!FileIsExist(fname, FILE_COMMON))
      return "";
   int h = FileOpen(fname, FILE_READ | FILE_TXT | FILE_COMMON | FILE_UNICODE);
   if(h == INVALID_HANDLE)
      return "";
   string s = "";
   while(!FileIsEnding(h))
      s += FileReadString(h);
   FileClose(h);
   return s;
}

void RainbowDeleteOpenSnapshot(long position_id)
{
   string fname = RainbowSnapshotFilename(position_id);
   if(FileIsExist(fname, FILE_COMMON))
      FileDelete(fname, FILE_COMMON);
}
//+------------------------------------------------------------------+
