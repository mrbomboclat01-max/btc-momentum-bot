// Triple-EMA Trend Momentum bot for 1-minute cbBTC/USDC on Orca Whirlpool.
//
// Strategy overview (single asset, long only):
//   Entry:  EMA(5) > EMA(21) > EMA(55)  — triple EMA alignment (bullish trend at three scales)
//           RSI(14) in [50, 68]           — healthy momentum, not overbought
//           MOM(14) > 0                   — net positive over last 14 bars
//   Exit (first trigger):
//     1. EMA(5) crosses below EMA(21)    — primary trend reversal signal
//     2. RSI(14) > 76                    — extreme overbought, take gains
//     3. value < cost × 985/1000         — hard stop at −1.5%
//     4. value > cost × 1025/1000        — target at +2.5% (ride trend, cap greed)
//
// Round-trip cost ≈ 26 bps; target gives net ≈ +2.24%; stop gives max per-trade loss ≈ −1.76%.
// Max drawdown guard: 25% limit.  At most 1 position (100% of equity).
//
// Deterministic: float64 IEEE-754, no Math.random, no Date, no process.env, no fs.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// ── indicator parameters ───────────────────────────────────────────────────────
const FAST_SPAN   = 5;
const MID_SPAN    = 21;
const SLOW_SPAN   = 55;
const RSI_PERIOD  = 14;
const MOM_PERIOD  = 14;

const RSI_ENTRY_LO = 50;
const RSI_ENTRY_HI = 68;
const RSI_EXIT     = 76;

// bigint ratios for PnL checks (cost already includes buy fee)
const STOP_N   = 985n;  const STOP_D   = 1000n;  // stop  at −1.5%
const TARGET_N = 1025n; const TARGET_D = 1000n;  // take profit at +2.5%

const MAX_SLIPPAGE_BPS = 100; // 1% max slippage per order

// ── indicator state ────────────────────────────────────────────────────────────

interface Ema { span: number; warm: number[]; value: number | null }
interface Rsi { prevClose: number | null; seed: number[]; gain: number | null; loss: number | null }

interface Series {
  fast: Ema;
  mid: Ema;
  slow: Ema;
  rsi: Rsi;
  closes: number[];          // last MOM_PERIOD+1 closes, oldest first
  prevFastAboveMid: boolean | null;
}

const series = new Map<string, Series>();

function mkEma(span: number): Ema { return { span, warm: [], value: null }; }
function mkRsi(): Rsi { return { prevClose: null, seed: [], gain: null, loss: null }; }

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

type Signal = 'up' | 'down' | null;

function push(bar: Bar): Signal {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = { fast: mkEma(FAST_SPAN), mid: mkEma(MID_SPAN), slow: mkEma(SLOW_SPAN),
          rsi: mkRsi(), closes: [], prevFastAboveMid: null };
    series.set(bar.symbol, s);
  }

  const c = Number(bar.c);
  stepEma(s.fast, c);
  stepEma(s.mid, c);
  stepEma(s.slow, c);

  const rsiVal = stepRsi(s.rsi, c);

  s.closes.push(c);
  if (s.closes.length > MOM_PERIOD + 1) s.closes.shift();
  const mom = s.closes.length > MOM_PERIOD ? c - s.closes[0]! : null;

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
  // exit trigger: overbought
  if (rsiVal !== null && rsiVal > RSI_EXIT) return 'down';

  // entry: all three EMAs aligned bullish + RSI in zone + positive momentum
  if (
    fastAboveMid &&
    mid.value > slow.value &&
    rsiVal !== null && rsiVal >= RSI_ENTRY_LO && rsiVal <= RSI_ENTRY_HI &&
    mom !== null && mom > 0
  ) return 'up';

  return null;
}

function shouldExit(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }, sig: Signal): boolean {
  if (sig === 'down') return true;
  const val = state.value(symbol, held.qty);
  if (val * STOP_D   <= held.cost * STOP_N)   return true; // hard stop −1.5%
  if (val * TARGET_D >= held.cost * TARGET_N) return true; // take profit +2.5%
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
        if (shouldExit(state, symbol, held, sig))
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      } else if (sig === 'up') {
        entries.push(symbol);
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
      cash -= slice;
      room--;
    }

    return orders;
  },
});
