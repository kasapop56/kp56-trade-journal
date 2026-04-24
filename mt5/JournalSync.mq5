//+------------------------------------------------------------------+
//|                                                  JournalSync.mq5 |
//|   Sends closed trades + periodic balance snapshots to the KP56   |
//|   trade journal webhook. Zero credentials leave the VPS.         |
//+------------------------------------------------------------------+
#property copyright "KP56"
#property version   "1.00"
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
//| OnTradeTransaction fires on every trade event.                   |
//| We care only about DEAL_ADD where the deal's entry direction is  |
//| OUT (a closing deal) — that's the moment a position closes.      |
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
   if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY) return;

   string sym = HistoryDealGetString(deal, DEAL_SYMBOL);
   if(StringLen(SymbolFilter) > 0 && sym != SymbolFilter) return;

   long magic = HistoryDealGetInteger(deal, DEAL_MAGIC);
   if(MagicFilter != 0 && magic != MagicFilter) return;

   SendTradeClosed(deal);

   if(SendBalanceOnClose)
      SendBalanceSnapshot();
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
   json += "\"equity_after\":"  + DoubleToString(eq, 2);
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
