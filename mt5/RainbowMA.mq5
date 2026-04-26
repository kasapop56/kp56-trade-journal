//+------------------------------------------------------------------+
//|                                                    RainbowMA.mq5 |
//|                        Converted from TradingView by Claude      |
//|                                                                  |
//|  v1.20 — Slow MA cross alerts routed via Universal TG Helper     |
//|          queue (no MT5 popup). Matches Baby/TMA protocol.        |
//|  v1.30 — RainbowJournal_PublishState() — publish multi-TF state  |
//|          via RAINBOW_* GlobalVariables for the JournalSync EA    |
//|          (Phase 3c). Single-chart instance queries M1/M5/M15/H1  |
//|          via iMA(); attach to one chart only.                    |
//+------------------------------------------------------------------+
#property copyright "Copyright 2025"
#property link      ""
#property version   "1.30"
#property indicator_chart_window
#property indicator_buffers 8
#property indicator_plots   8

//--- plot MA1
#property indicator_label1  "MA-1"
#property indicator_type1   DRAW_LINE
#property indicator_color1  clrYellow
#property indicator_style1  STYLE_SOLID
#property indicator_width1  1

//--- plot MA2
#property indicator_label2  "MA-2"
#property indicator_type2   DRAW_LINE
#property indicator_color2  clrOrange
#property indicator_style2  STYLE_SOLID
#property indicator_width2  1

//--- plot MA3
#property indicator_label3  "MA-3"
#property indicator_type3   DRAW_LINE
#property indicator_color3  clrOlive
#property indicator_style3  STYLE_SOLID
#property indicator_width3  1

//--- plot MA4
#property indicator_label4  "MA-4"
#property indicator_type4   DRAW_LINE
#property indicator_color4  clrGreen
#property indicator_style4  STYLE_SOLID
#property indicator_width4  1

//--- plot MA5
#property indicator_label5  "MA-5"
#property indicator_type5   DRAW_LINE
#property indicator_color5  clrTeal
#property indicator_style5  STYLE_SOLID
#property indicator_width5  1

//--- plot MA6
#property indicator_label6  "MA-6"
#property indicator_type6   DRAW_LINE
#property indicator_color6  clrBlue
#property indicator_style6  STYLE_SOLID
#property indicator_width6  1

//--- plot MA7
#property indicator_label7  "MA-7"
#property indicator_type7   DRAW_LINE
#property indicator_color7  clrPurple
#property indicator_style7  STYLE_SOLID
#property indicator_width7  1

//--- plot MA8
#property indicator_label8  "MA-8"
#property indicator_type8   DRAW_LINE
#property indicator_color8  clrRed
#property indicator_style8  STYLE_SOLID
#property indicator_width8  1

//--- input parameters
input group "=== Moving Averages ==="
input int      InpLen1=20;       // Fast MA Period
input int      InpLen2=25;       // MA-2 Period
input int      InpLen3=30;       // MA-3 Period
input int      InpLen4=35;       // MA-4 Period
input int      InpLen5=40;       // MA-5 Period
input int      InpLen6=45;       // MA-6 Period
input int      InpLen7=50;       // MA-7 Period
input int      InpLen8=55;       // Slow MA Period
input ENUM_APPLIED_PRICE InpAppliedPrice = PRICE_CLOSE; // Applied Price

input group "=== Slow MA Cross Alerts (TG Helper) ==="
input bool     InpEnableAlert   = true;   // Enable Slow MA Cross Alerts
input bool     InpRequireColor  = true;   // Require candle color (Red=below, Green=above)
input bool     InpPushNotify    = false;  // Also send MT5 Push Notification (mobile)

input group "=== Journal State Publish (Phase 3c) ==="
input bool     InpJournalEnabled = true;  // Publish RAINBOW_* GVs for JournalSync EA

//--- indicator buffers
double         MA1Buffer[];
double         MA2Buffer[];
double         MA3Buffer[];
double         MA4Buffer[];
double         MA5Buffer[];
double         MA6Buffer[];
double         MA7Buffer[];
double         MA8Buffer[];

//--- Handles for the EMAs
int            MA1Handle;
int            MA2Handle;
int            MA3Handle;
int            MA4Handle;
int            MA5Handle;
int            MA6Handle;
int            MA7Handle;
int            MA8Handle;

//--- Alert tracking
datetime       g_last_alert_bar_time = 0;

//--- TG Helper queue GV name (must match Universal_TG_Helper.mq5)
#define TG_QUEUE_GV "BABY_ALERT_NEW"

//--- Journal multi-TF MA handles (Phase 3c). One iMA handle per (TF × MA-period).
//    Indexed [tf_idx][ma_idx] where tf_idx 0..3 maps to M1,M5,M15,H1 and
//    ma_idx 0..7 maps to InpLen1..InpLen8.
int            g_jHandles[4][8];
ENUM_TIMEFRAMES g_jTF[4]   = {PERIOD_M1, PERIOD_M5, PERIOD_M15, PERIOD_H1};
string         g_jTag[4]   = {"M1", "M5", "M15", "H1"};

//+------------------------------------------------------------------+
//| Convert timeframe enum to short string (M5, H1, etc.)            |
//+------------------------------------------------------------------+
string TFString()
  {
   string s = EnumToString((ENUM_TIMEFRAMES)_Period);
   return StringSubstr(s, 7); // "PERIOD_M5" -> "M5"
  }

//+------------------------------------------------------------------+
//| Send a message to Universal TG Helper via queue file              |
//| Protocol (must match Universal_TG_Helper.mq5):                    |
//|   1. Write file to Common folder FIRST (so helper finds it)       |
//|   2. Then bump GV counter (helper polls and processes)            |
//+------------------------------------------------------------------+
bool SendToTGQueue(string message)
  {
//--- Ensure counter GV exists (helper also sets it, this is fallback)
   if(!GlobalVariableCheck(TG_QUEUE_GV))
      GlobalVariableSet(TG_QUEUE_GV, 0);

//--- Peek next ID (don't bump yet)
   long newID = (long)GlobalVariableGet(TG_QUEUE_GV) + 1;
   string filename = "baby_alert_" + IntegerToString(newID) + ".txt";

//--- Write the file FIRST so helper always finds valid content
   int handle = FileOpen(filename,
                         FILE_WRITE | FILE_TXT | FILE_COMMON | FILE_UNICODE);
   if(handle == INVALID_HANDLE)
     {
      Print("⚠ RainbowMA: could not create TG queue file: ",
            filename, " err=", GetLastError());
      return false;
     }
   FileWriteString(handle, message);
   FileClose(handle);

//--- Now publish by bumping the counter — helper will pick it up
   GlobalVariableSet(TG_QUEUE_GV, (double)newID);
   return true;
  }

//+------------------------------------------------------------------+
//| Custom indicator initialization function                         |
//+------------------------------------------------------------------+
int OnInit()
  {
//--- indicator buffers mapping
   SetIndexBuffer(0, MA1Buffer, INDICATOR_DATA);
   SetIndexBuffer(1, MA2Buffer, INDICATOR_DATA);
   SetIndexBuffer(2, MA3Buffer, INDICATOR_DATA);
   SetIndexBuffer(3, MA4Buffer, INDICATOR_DATA);
   SetIndexBuffer(4, MA5Buffer, INDICATOR_DATA);
   SetIndexBuffer(5, MA6Buffer, INDICATOR_DATA);
   SetIndexBuffer(6, MA7Buffer, INDICATOR_DATA);
   SetIndexBuffer(7, MA8Buffer, INDICATOR_DATA);

//--- Create EMA handles
   MA1Handle = iMA(_Symbol, PERIOD_CURRENT, InpLen1, 0, MODE_EMA, InpAppliedPrice);
   MA2Handle = iMA(_Symbol, PERIOD_CURRENT, InpLen2, 0, MODE_EMA, InpAppliedPrice);
   MA3Handle = iMA(_Symbol, PERIOD_CURRENT, InpLen3, 0, MODE_EMA, InpAppliedPrice);
   MA4Handle = iMA(_Symbol, PERIOD_CURRENT, InpLen4, 0, MODE_EMA, InpAppliedPrice);
   MA5Handle = iMA(_Symbol, PERIOD_CURRENT, InpLen5, 0, MODE_EMA, InpAppliedPrice);
   MA6Handle = iMA(_Symbol, PERIOD_CURRENT, InpLen6, 0, MODE_EMA, InpAppliedPrice);
   MA7Handle = iMA(_Symbol, PERIOD_CURRENT, InpLen7, 0, MODE_EMA, InpAppliedPrice);
   MA8Handle = iMA(_Symbol, PERIOD_CURRENT, InpLen8, 0, MODE_EMA, InpAppliedPrice);

//--- Check if handles are created successfully
   if(MA1Handle == INVALID_HANDLE || MA2Handle == INVALID_HANDLE ||
      MA3Handle == INVALID_HANDLE || MA4Handle == INVALID_HANDLE ||
      MA5Handle == INVALID_HANDLE || MA6Handle == INVALID_HANDLE ||
      MA7Handle == INVALID_HANDLE || MA8Handle == INVALID_HANDLE)
     {
      Print("Failed to create one or more EMA handles");
      return(INIT_FAILED);
     }

//--- Set indicator name and short name
   string short_name = "Rainbow MA";
   IndicatorSetString(INDICATOR_SHORTNAME, short_name);

//--- Set indexes drawing properties
   for(int i = 0; i < 8; i++)
     {
      PlotIndexSetInteger(i, PLOT_DRAW_BEGIN, MathMax(InpLen1, MathMax(InpLen2, MathMax(InpLen3, MathMax(InpLen4, MathMax(InpLen5, MathMax(InpLen6, MathMax(InpLen7, InpLen8))))))));
     }

//--- Reset alert tracking
   g_last_alert_bar_time = 0;

//--- Journal handles: 4 TFs × 8 MA periods. Same length array as the chart's
//    own indicator (whatever the user configured in InpLen1..InpLen8) is
//    reused for every TF — keeps inputs minimal. If per-TF tuning is needed
//    later, add InpLenM5_8 etc. and route here.
   int lens[8] = {InpLen1, InpLen2, InpLen3, InpLen4,
                  InpLen5, InpLen6, InpLen7, InpLen8};
   for(int t = 0; t < 4; t++)
     {
      for(int m = 0; m < 8; m++)
        {
         g_jHandles[t][m] = iMA(_Symbol, g_jTF[t], lens[m], 0,
                                MODE_EMA, InpAppliedPrice);
         if(g_jHandles[t][m] == INVALID_HANDLE)
            PrintFormat("⚠ RainbowMA: failed to create journal handle %s MA-%d",
                        g_jTag[t], m + 1);
        }
     }

   Print("✅ RainbowMA v1.30 loaded | Alerts: ",
         (InpEnableAlert ? "ON (TG queue)" : "OFF"),
         " | Color filter: ", (InpRequireColor ? "ON" : "OFF"),
         " | Push: ", (InpPushNotify ? "ON" : "OFF"),
         " | Journal: ", (InpJournalEnabled ? "ON (M1/M5/M15/H1)" : "OFF"));

   return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
//| Custom indicator deinitialization function                       |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
//--- Release chart-display handles
   IndicatorRelease(MA1Handle);
   IndicatorRelease(MA2Handle);
   IndicatorRelease(MA3Handle);
   IndicatorRelease(MA4Handle);
   IndicatorRelease(MA5Handle);
   IndicatorRelease(MA6Handle);
   IndicatorRelease(MA7Handle);
   IndicatorRelease(MA8Handle);

//--- Release journal multi-TF handles
   for(int t = 0; t < 4; t++)
      for(int m = 0; m < 8; m++)
         if(g_jHandles[t][m] != INVALID_HANDLE)
            IndicatorRelease(g_jHandles[t][m]);
  }

//+------------------------------------------------------------------+
//| Build the Telegram message (HTML formatted)                       |
//+------------------------------------------------------------------+
string BuildAlertMessage(bool isBearish,
                         double closePrice,
                         double slowMAValue,
                         datetime barTime)
  {
   string tf_str    = TFString();
   string price_str = DoubleToString(closePrice, _Digits);
   string ma_str    = DoubleToString(slowMAValue, _Digits);
   string tStr      = TimeToString(barTime, TIME_MINUTES);

   string icon     = isBearish ? "🔴" : "🟢";
   string headTag  = isBearish ? "BEARISH CROSS" : "BULLISH CROSS";
   string arrow    = isBearish ? "📉" : "📈";
   string candle   = isBearish ? "Red candle confirmed"
                               : "Green candle confirmed";

   string msg = icon + " <b>RainbowMA | " + headTag + "</b>\n"
              + "━━━━━━━━━━━━━━━\n"
              + "📌 " + _Symbol + " " + tf_str + "\n"
              + "💲 Close: " + price_str + "\n"
              + arrow + " Slow MA(" + IntegerToString(InpLen8) + "): " + ma_str + "\n";

   if(InpRequireColor)
      msg += "🕯 " + candle + "\n";

   msg += "⏰ " + tStr;

   return msg;
  }

//+------------------------------------------------------------------+
//| Check for Slow MA cross + candle color, route to TG queue         |
//+------------------------------------------------------------------+
void CheckSlowMACrossAlert(const int rates_total,
                           const datetime &time[],
                           const double &open[],
                           const double &close[])
  {
   if(!InpEnableAlert) return;
   if(rates_total < InpLen8 + 3) return;

//--- Current forming bar time (rightmost bar, still open)
   datetime current_forming_bar = time[rates_total - 1];

//--- First run: record baseline, don't alert on historical bars
   if(g_last_alert_bar_time == 0)
     {
      g_last_alert_bar_time = current_forming_bar;
      return;
     }

//--- No new bar yet? nothing to do
   if(current_forming_bar == g_last_alert_bar_time) return;

//--- A new bar has formed -> evaluate the bar that JUST CLOSED
   int closed_idx = rates_total - 2; // just-closed bar
   int prev_idx   = rates_total - 3; // the bar before that
   if(closed_idx < 0 || prev_idx < 0) return;

   double slow_ma_closed = MA8Buffer[closed_idx];
   double slow_ma_prev   = MA8Buffer[prev_idx];

//--- Guard against empty / uninitialized MA values
   if(slow_ma_closed == EMPTY_VALUE || slow_ma_prev == EMPTY_VALUE) return;
   if(slow_ma_closed <= 0.0 || slow_ma_prev <= 0.0) return;

   double c_closed = close[closed_idx];
   double c_prev   = close[prev_idx];
   double o_closed = open[closed_idx];
   datetime t_closed = time[closed_idx];

//--- Cross detection
   bool crossed_below = (c_prev >= slow_ma_prev) && (c_closed <  slow_ma_closed);
   bool crossed_above = (c_prev <= slow_ma_prev) && (c_closed >  slow_ma_closed);

//--- Candle color
   bool is_red   = c_closed < o_closed;
   bool is_green = c_closed > o_closed;

//--- Apply color filter if enabled
   bool bearish_signal = crossed_below && (!InpRequireColor || is_red);
   bool bullish_signal = crossed_above && (!InpRequireColor || is_green);

   if(!bearish_signal && !bullish_signal)
     {
      // Mark bar as processed so we don't re-evaluate on every tick
      g_last_alert_bar_time = current_forming_bar;
      return;
     }

//--- Build HTML message
   string msg = BuildAlertMessage(bearish_signal, c_closed, slow_ma_closed, t_closed);

//--- Route to TG Helper queue (silent — no popup)
   if(SendToTGQueue(msg))
      Print("📤 RainbowMA alert queued to TG Helper (",
            (bearish_signal ? "BEARISH" : "BULLISH"), ")");
   else
      Print("⚠ RainbowMA: failed to queue alert");

//--- Optional mobile push notification
   if(InpPushNotify)
     {
      // Plain text for push (no HTML rendering on mobile notification)
      string pushMsg = StringFormat("RainbowMA %s %s | %s cross at %s (Slow MA %s)",
                                    _Symbol, TFString(),
                                    (bearish_signal ? "BEARISH" : "BULLISH"),
                                    DoubleToString(c_closed, _Digits),
                                    DoubleToString(slow_ma_closed, _Digits));
      SendNotification(pushMsg);
     }

//--- Dedup: mark this new-bar event as handled
   g_last_alert_bar_time = current_forming_bar;
  }

//+------------------------------------------------------------------+
//| Journal Phase 3c — multi-TF state publish for JournalSync EA.    |
//|                                                                  |
//| GV protocol (read by trade-journal/mt5/JournalSync.mq5):         |
//|   RAINBOW_STATE_TS                : TimeCurrent() at last write   |
//|   RAINBOW_<TF>_SLOW_MA            : MA-8 EMA on TF, last bar      |
//|   RAINBOW_<TF>_CLOSE_PRICE        : last completed bar's close    |
//|   RAINBOW_<TF>_BAND_IDX           : -1 above all MAs, 0..6 in     |
//|                                     gap N of sorted bands, 7      |
//|                                     below all                     |
//|   RAINBOW_<TF>_CANDLE             : 1 green, -1 red, 0 doji       |
//|   RAINBOW_<TF>_BODY_POINTS        : abs(close-open) / _Point      |
//|   RAINBOW_<TF>_ORDER              : 1 BULL_STACK, -1 BEAR_STACK,  |
//|                                     0 MIXED                       |
//|                                                                  |
//| <TF> ∈ {M1, M5, M15, H1}. EA decodes ints to text before POSTing  |
//| to the webhook. If a TF's data isn't ready, all six fields are    |
//| set to 0 — EA treats SLOW_MA == 0 as "not captured" → null.       |
//+------------------------------------------------------------------+
int RainbowOrderState(const double &mas[])
  {
   bool bull = true, bear = true;
   for(int i = 0; i < 7; i++)
     {
      if(mas[i] <= mas[i + 1]) bull = false;
      if(mas[i] >= mas[i + 1]) bear = false;
     }
   if(bull) return  1;
   if(bear) return -1;
   return 0;
  }

int RainbowBandIdx(const double price, const double &mas[])
  {
   double sorted[8];
   for(int i = 0; i < 8; i++) sorted[i] = mas[i];
   ArraySort(sorted);
   if(price >= sorted[7]) return -1; // above all
   if(price <  sorted[0]) return  7; // below all
   for(int i = 0; i < 7; i++)
      if(price >= sorted[i] && price < sorted[i + 1])
         return i;
   return 7;
  }

void PublishTFEmpty(const string tag)
  {
   string p = "RAINBOW_" + tag + "_";
   GlobalVariableSet(p + "SLOW_MA",     0.0);
   GlobalVariableSet(p + "CLOSE_PRICE", 0.0);
   GlobalVariableSet(p + "BAND_IDX",    0.0);
   GlobalVariableSet(p + "CANDLE",      0.0);
   GlobalVariableSet(p + "BODY_POINTS", 0.0);
   GlobalVariableSet(p + "ORDER",       0.0);
  }

void RainbowJournal_PublishState()
  {
   if(!InpJournalEnabled) return;

   for(int t = 0; t < 4; t++)
     {
      double mas[8];
      bool   ok = true;
      for(int m = 0; m < 8 && ok; m++)
        {
         double tmp[1];
         if(g_jHandles[t][m] == INVALID_HANDLE) { ok = false; break; }
         // Index 1 = last completed bar — never the forming bar.
         if(CopyBuffer(g_jHandles[t][m], 0, 1, 1, tmp) <= 0) { ok = false; break; }
         mas[m] = tmp[0];
         if(mas[m] == 0.0 || mas[m] == EMPTY_VALUE) { ok = false; break; }
        }

      if(!ok)
        {
         // TF not warmed up (history not loaded) — publish sentinels so EA
         // logs a clean miss rather than reading stale GVs from a previous run.
         PublishTFEmpty(g_jTag[t]);
         continue;
        }

      double last_o = iOpen(_Symbol,  g_jTF[t], 1);
      double last_c = iClose(_Symbol, g_jTF[t], 1);
      if(last_o <= 0.0 || last_c <= 0.0)
        {
         PublishTFEmpty(g_jTag[t]);
         continue;
        }

      int    candle      = (last_c > last_o) ?  1 : (last_c < last_o ? -1 : 0);
      double body_points = MathAbs(last_c - last_o) / _Point;
      int    band        = RainbowBandIdx(last_c, mas);
      int    order       = RainbowOrderState(mas);

      string p = "RAINBOW_" + g_jTag[t] + "_";
      GlobalVariableSet(p + "SLOW_MA",     mas[7]);          // MA-8
      GlobalVariableSet(p + "CLOSE_PRICE", last_c);
      GlobalVariableSet(p + "BAND_IDX",    (double)band);
      GlobalVariableSet(p + "CANDLE",      (double)candle);
      GlobalVariableSet(p + "BODY_POINTS", body_points);
      GlobalVariableSet(p + "ORDER",       (double)order);
     }

   GlobalVariableSet("RAINBOW_STATE_TS", (double)TimeCurrent());
  }

//+------------------------------------------------------------------+
//| Custom indicator iteration function                              |
//+------------------------------------------------------------------+
int OnCalculate(const int rates_total,
                const int prev_calculated,
                const datetime &time[],
                const double &open[],
                const double &high[],
                const double &low[],
                const double &close[],
                const long &tick_volume[],
                const long &volume[],
                const int &spread[])
  {
//--- Check for minimum required bars
   if(rates_total < MathMax(InpLen1, MathMax(InpLen2, MathMax(InpLen3, MathMax(InpLen4, MathMax(InpLen5, MathMax(InpLen6, MathMax(InpLen7, InpLen8))))))))
      return(0);

//--- Copy MA values to the buffers
   if(CopyBuffer(MA1Handle, 0, 0, rates_total, MA1Buffer) <= 0 ||
      CopyBuffer(MA2Handle, 0, 0, rates_total, MA2Buffer) <= 0 ||
      CopyBuffer(MA3Handle, 0, 0, rates_total, MA3Buffer) <= 0 ||
      CopyBuffer(MA4Handle, 0, 0, rates_total, MA4Buffer) <= 0 ||
      CopyBuffer(MA5Handle, 0, 0, rates_total, MA5Buffer) <= 0 ||
      CopyBuffer(MA6Handle, 0, 0, rates_total, MA6Buffer) <= 0 ||
      CopyBuffer(MA7Handle, 0, 0, rates_total, MA7Buffer) <= 0 ||
      CopyBuffer(MA8Handle, 0, 0, rates_total, MA8Buffer) <= 0)
     {
      Print("Failed to copy indicator data");
      return(0);
     }

//--- Slow MA cross alert check (evaluated once per new bar)
   CheckSlowMACrossAlert(rates_total, time, open, close);

//--- Phase 3c: publish multi-TF state for JournalSync EA (every tick is fine
//    — values come from last completed bar on each TF, so refresh is cheap
//    and EA always sees a current snapshot when it reads GVs at trade events).
   RainbowJournal_PublishState();

//--- Return the number of calculated bars
   return(rates_total);
  }
//+------------------------------------------------------------------+
