// Triple-EMA Trend Momentum bot for 1-minute cbBTC/USDC on Orca Whirlpool.
//
// Strategy overview (single asset, long only):
//   Entry:  EMA(5) > EMA(21) > EMA(55)  — triple EMA alignment (bullish trend at three scales)
//           RSI(14) in [48, 70]           — healthy momentum zone, not overbought
//           ROC(14) > 0                   — positive 14-bar rate-of-change (percentage)
//           ATR(14) > min threshold       — needs real movement to clear fees
//           no cooldown active            — wait MIN_COOLDOWN_BARS after any exit
//   Exit (first trigger wins):
//     1. EMA(5) crosses below EMA(21)    — primary trend reversal signal
//     2. RSI(14) > 75                    — extreme overbought, take gains early
//     3. value < cost × 982/1000         — hard stop at −1.8%
//     4. value > cost × 1030/1000        — target at +3.0% (ride trend, cap greed)
//     5. held ≥ MAX_HOLD_BARS            — time-stop: don't hold a stale trade forever
//
// Round-trip cost ≈ 26 bps; target gives net ≈ +2.74%; stop gives max loss ≈ −2.06%.
// ATR filter keeps us out during flat/no-movement bars where fees dominate.
// Cooldown of 3 bars after each exit avoids immediate re-entry on whipsaws.
//
// Deterministic: float64 IEEE-754, no Math.random, no Date, no process.env, no fs.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// ── indicator parameters ───────────────────────────────────────────────────────
const FAST_SPAN  = 5;
const MID_SPAN   = 21;
const SLOW_SPAN  = 55;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;
const ROC_PERIOD = 14;    // rate-of-change lookback

const RSI_ENTRY_LO = 48;
const RSI_ENTRY_HI = 70;
const RSI_EXIT     = 75;

// ATR as a fraction of price: require at least 6 bps average range (0.06%)
// to ensure there's enough movement to profit after the 26 bps round-trip cost.
const ATR_MIN_BPS = 6;

const MIN_COOLDOWN_BARS = 3;  // bars to skip after any exit before re-entering
const MAX_HOLD_BARS     = 90; // time-stop: exit after 90 minutes if still in

// bigint ratios for PnL checks (cost already includes buy fee)
const STOP_N   = 982n;  const STOP_D   = 1000n;  // hard stop at −1.8%
const TARGET_N = 1030n; const TARGET_D = 1000n;  // take profit at +3.0%

const MAX_SLIPPAGE_BPS = 100; // 1% max slippage per order

// ── indicator state ────────────────────────────────────────────────────────────

interface Ema { span: number; warm: number[]; value: number | null }
interface Rsi { prevClose: number | null; seed: number[]; gain: number | null; loss: number | null }
interface Atr { prevClose: number | null; seed: number[]; value: number | null }

interface Series {
  fast: Ema;
  mid: Ema;
  slow: Ema;
  rsi: Rsi;
  atr: Atr;
  closes: number[];          // last ROC_PERIOD+1 closes, oldest first
  prevFastAboveMid: boolean | null;
}

// per-symbol exit-cooldown: bar seq of the last exit, so we can compare to current seq
const cooldownUntil = new Map<string, number>();
// per-symbol entry bar seq (for time-stop)
const entrySeq = new Map<string, number>();

const series = new Map<string, Series>();

function mkEma(span: number): Ema { return { span, warm: [], value: null }; }
function mkRsi(): Rsi { return { prevClose: null, seed: [], gain: null, loss: null }; }
function mkAtr(): Atr { return { prevClose: null, seed: [], value: null }; }

function stepEma(e: Ema, c: number): void {
  if (e.value !== null) { e.value += (2 / (e.span + 1)) * (c - e.value); return; }
  e.warm.push(c);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function stepRsi(r: Rsi, c: number): number | null {
  if (r.prevClose !== null) {
    const delta = c - r.prevClose;
    const up   = delta > 0 ?  delta : 0;
    const down = delta < 0 ? -delta : 0;
    if (r.gain === null) {
      r.seed.push(delta);
      if (r.seed.length === RSI_PERIOD) {
        r.gain = r.seed.reduce((a, x) => a + (x > 0 ? x : 0), 0) / RSI_PERIOD;
        r.loss = r.seed.reduce((a, x) => a + (x < 0 ? -x : 0), 0) / RSI_PERIOD;
      }
    } else {
      r.gain = (r.gain * (RSI_PERIOD - 1) + up)   / RSI_PERIOD;
      r.loss = (r.loss! * (RSI_PERIOD - 1) + down) / RSI_PERIOD;
    }
  }
  r.prevClose = c;
  if (r.gain === null || r.loss === null) return null;
  const moved = r.gain + r.loss;
  return moved === 0 ? 50 : (100 * r.gain) / moved;
}

function stepAtr(a: Atr, bar: Bar): number | null {
  const h = Number(bar.h), l = Number(bar.l), c = Number(bar.c);
  let tr = h - l;
  if (a.prevClose !== null) {
    const tr2 = Math.abs(h - a.prevClose);
    const tr3 = Math.abs(l - a.prevClose);
    if (tr2 > tr) tr = tr2;
    if (tr3 > tr) tr = tr3;
  }
  a.prevClose = c;
  if (a.value !== null) {
    a.value = (a.value * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
  } else {
    a.seed.push(tr);
    if (a.seed.length === ATR_PERIOD) a.value = a.seed.reduce((x, y) => x + y, 0) / ATR_PERIOD;
  }
  return a.value;
}

type Signal = 'up' | 'down' | null;

function push(bar: Bar): Signal {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = { fast: mkEma(FAST_SPAN), mid: mkEma(MID_SPAN), slow: mkEma(SLOW_SPAN),
          rsi: mkRsi(), atr: mkAtr(), closes: [], prevFastAboveMid: null };
    series.set(bar.symbol, s);
  }

  const c = Number(bar.c);
  stepEma(s.fast, c);
  stepEma(s.mid, c);
  stepEma(s.slow, c);

  const rsiVal = stepRsi(s.rsi, c);
  const atrVal = stepAtr(s.atr, bar);

  s.closes.push(c);
  if (s.closes.length > ROC_PERIOD + 1) s.closes.shift();
  // Rate-of-change as percentage: (c - c[n]) / c[n]
  const roc = s.closes.length > ROC_PERIOD
    ? (c - s.closes[0]!) / s.closes[0]!
    : null;

  const { fast, mid, slow } = s;
  if (fast.value === null || mid.value === null || slow.value === null) {
    s.prevFastAboveMid = fast.value !== null && mid.value !== null ? fast.value > mid.value : null;
    return null;
  }

  const fastAboveMid = fast.value > mid.value;
  const prev = s.prevFastAboveMid;
  s.prevFastAboveMid = fastAboveMid;

  // exit trigger: EMA(5) just crossed below EMA(21)
  if (prev === true && !fastAboveMid) return 'down';
  // exit trigger: overbought RSI
  if (rsiVal !== null && rsiVal > RSI_EXIT) return 'down';

  // entry: triple EMA aligned + RSI zone + positive ROC + sufficient ATR
  const atrOk = atrVal !== null && c > 0 && (atrVal / c) * 10_000 >= ATR_MIN_BPS;
  if (
    fastAboveMid &&
    mid.value > slow.value &&
    rsiVal !== null && rsiVal >= RSI_ENTRY_LO && rsiVal <= RSI_ENTRY_HI &&
    roc !== null && roc > 0 &&
    atrOk
  ) return 'up';

  return null;
}

function shouldExit(
  state: BarsState,
  symbol: string,
  held: { qty: bigint; cost: bigint },
  sig: Signal,
  currentSeq: number,
): boolean {
  if (sig === 'down') return true;
  const val = state.value(symbol, held.qty);
  if (val * STOP_D   <= held.cost * STOP_N)   return true; // hard stop −1.8%
  if (val * TARGET_D >= held.cost * TARGET_N) return true; // take profit +3.0%
  const entry = entrySeq.get(symbol);
  if (entry !== undefined && currentSeq - entry >= MAX_HOLD_BARS) return true; // time-stop
  return false;
}

// ── main loop ──────────────────────────────────────────────────────────────────

await runBars({
  onBatch(state: BarsState, batch) {
    const signals = new Map<string, Signal>();
    for (const bar of batch.bars) signals.set(bar.symbol, push(bar));

    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: string[] = [];

    for (const { symbol } of state.hello.symbols) {
      if (!signals.has(symbol)) continue;
      const sig  = signals.get(symbol)!;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        if (shouldExit(state, symbol, held, sig, batch.seq)) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          cooldownUntil.set(symbol, batch.seq + MIN_COOLDOWN_BARS);
          entrySeq.delete(symbol);
        }
      } else if (sig === 'up') {
        const cooldown = cooldownUntil.get(symbol) ?? 0;
        if (batch.seq >= cooldown) entries.push(symbol);
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots    = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake    = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = slots - state.positions.size;
    let cash = state.cash;

    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      entrySeq.set(symbol, batch.seq);
      cash -= slice;
      room--;
    }

    return orders;
  },
});
