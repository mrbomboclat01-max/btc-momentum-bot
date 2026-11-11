// Trend-Filtered Oversold Reversal bot for 1-minute cbBTC/USDC.
//
// Core insight: on 1-minute BTC, complex indicators generate too many signals.
// Every false entry costs ~26 bps in fees. This bot waits for EXTREME conditions
// before acting, targeting 2-5 high-conviction trades per day.
//
// Regime filter — EMA(50) vs EMA(100):
//   Uptrend:   EMA50 > EMA100 × 1.0003   → allow both entry modes
//   Sideways:  EMA50 within ±0.03% of EMA100 → allow oversold-only entries
//   Downtrend: EMA50 < EMA100 × 0.9997   → NO ENTRY (can't short; preserve capital)
//
// Entry (all conditions must hold simultaneously):
//   1. Regime is Uptrend or Sideways
//   2. RSI(14) < 30  — price is deeply oversold
//   3. Close < Lower Bollinger Band(20, 2σ) — statistically cheap
//   4. MACD(5,15,5) histogram just crossed from ≤0 to >0 — momentum turning
//   5. No active cooldown
//
// Exit (first trigger):
//   1. RSI(14) > 65           — recovery complete
//   2. Close > Middle BB      — price returned to mean
//   3. MACD histogram turns negative (crosses from ≥0 to <0) — momentum fading
//   4. value < cost × 988/1000  — hard stop −1.2%
//   5. value > cost × 1020/1000 — take-profit +2.0%
//   6. held ≥ 90 bars           — time-stop
//
// Round-trip cost ≈ 26 bps.  Net target ≈ +1.74%.  Net stop ≈ −1.46%.
// Warmup: 100 bars (EMA100 needs this before any trades are possible).
//
// Deterministic: float64 IEEE-754 only, no Math.random, no Date, no I/O.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// ── parameters ───────────────────────────────────────────────────────────────────
const EMA_FAST_TREND = 50;
const EMA_SLOW_TREND = 100;
// Regime threshold: EMA50 / EMA100 ratio thresholds
const UPTREND_RATIO   = 1.0003;  // EMA50 > EMA100 × this → uptrend
const DOWNTREND_RATIO = 0.9997;  // EMA50 < EMA100 × this → downtrend

const RSI_PERIOD = 14;
const RSI_ENTRY  = 30;   // deeply oversold threshold
const RSI_EXIT   = 65;   // recovery threshold

const BB_PERIOD  = 20;
const BB_MULT    = 2.0;

const MACD_FAST  = 5;
const MACD_SLOW  = 15;
const MACD_SIG   = 5;

const ATR_PERIOD = 14;
const ATR_MIN_BPS = 3; // skip flat bars where there's no movement to capture

const COOLDOWN   = 4;   // bars to wait after any exit
const MAX_HOLD   = 90;  // time-stop

// bigint PnL check ratios (cost already includes buy fee)
const STOP_N   = 988n; const STOP_D   = 1000n;  // hard stop −1.2%
const TARGET_N = 1020n; const TARGET_D = 1000n; // take-profit +2.0%

const MAX_SLIPPAGE_BPS = 100;

// ── indicator primitives ──────────────────────────────────────────────────────────

interface Ema { span: number; warm: number[]; value: number | null }
interface Rsi { prev: number | null; seed: number[]; gain: number | null; loss: number | null }
interface Atr { prev: number | null; seed: number[]; value: number | null }

function mkEma(span: number): Ema { return { span, warm: [], value: null }; }
function mkRsi(): Rsi { return { prev: null, seed: [], gain: null, loss: null }; }
function mkAtr(): Atr { return { prev: null, seed: [], value: null }; }

function stepEma(e: Ema, v: number): void {
  if (e.value !== null) { e.value += (2 / (e.span + 1)) * (v - e.value); return; }
  e.warm.push(v);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function stepRsi(r: Rsi, c: number): number | null {
  if (r.prev !== null) {
    const d = c - r.prev;
    const up = d > 0 ? d : 0, dn = d < 0 ? -d : 0;
    if (r.gain === null) {
      r.seed.push(d);
      if (r.seed.length === RSI_PERIOD) {
        r.gain = r.seed.reduce((a, x) => a + (x > 0 ? x : 0), 0) / RSI_PERIOD;
        r.loss = r.seed.reduce((a, x) => a + (x < 0 ? -x : 0), 0) / RSI_PERIOD;
      }
    } else {
      r.gain = (r.gain * (RSI_PERIOD - 1) + up) / RSI_PERIOD;
      r.loss = (r.loss! * (RSI_PERIOD - 1) + dn) / RSI_PERIOD;
    }
  }
  r.prev = c;
  if (r.gain === null) return null;
  const m = r.gain + r.loss!;
  return m === 0 ? 50 : 100 * r.gain / m;
}

function stepAtr(a: Atr, bar: Bar): number | null {
  const h = Number(bar.h), l = Number(bar.l), c = Number(bar.c);
  let tr = h - l;
  if (a.prev !== null) tr = Math.max(tr, Math.abs(h - a.prev), Math.abs(l - a.prev));
  a.prev = c;
  if (a.value !== null) {
    a.value = (a.value * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
  } else {
    a.seed.push(tr);
    if (a.seed.length === ATR_PERIOD) a.value = a.seed.reduce((x, y) => x + y, 0) / ATR_PERIOD;
  }
  return a.value;
}

// ── per-symbol state ──────────────────────────────────────────────────────────────

type Signal = 'up' | 'down' | null;

interface Series {
  emaFast: Ema;   // EMA(50) trend
  emaSlow: Ema;   // EMA(100) trend
  macdF:   Ema;   // MACD fast EMA(5)
  macdS:   Ema;   // MACD slow EMA(15)
  macdSig: Ema;   // MACD signal EMA(5) of histogram
  prevHist: number | null;
  rsi: Rsi;
  atr: Atr;
  bbCloses: number[];
  midBB: number | null;
}

const allSeries     = new Map<string, Series>();
const cooldownUntil = new Map<string, number>();
const entrySeq      = new Map<string, number>();

function getSeries(symbol: string): Series {
  let s = allSeries.get(symbol);
  if (s === undefined) {
    s = {
      emaFast: mkEma(EMA_FAST_TREND), emaSlow: mkEma(EMA_SLOW_TREND),
      macdF: mkEma(MACD_FAST), macdS: mkEma(MACD_SLOW), macdSig: mkEma(MACD_SIG),
      prevHist: null, rsi: mkRsi(), atr: mkAtr(), bbCloses: [], midBB: null,
    };
    allSeries.set(symbol, s);
  }
  return s;
}

function computeSignal(bar: Bar, s: Series): Signal {
  const c = Number(bar.c);

  // Trend EMAs
  stepEma(s.emaFast, c);
  stepEma(s.emaSlow, c);

  // RSI
  const rsiVal = stepRsi(s.rsi, c);

  // ATR
  const atrVal = stepAtr(s.atr, bar);

  // MACD(5,15,5)
  stepEma(s.macdF, c);
  stepEma(s.macdS, c);
  let hist: number | null = null;
  if (s.macdF.value !== null && s.macdS.value !== null) {
    const line = s.macdF.value - s.macdS.value;
    stepEma(s.macdSig, line);
    if (s.macdSig.value !== null) hist = line - s.macdSig.value;
  }
  const prevHist = s.prevHist;
  s.prevHist = hist;

  // Bollinger Bands(20, 2σ)
  s.bbCloses.push(c);
  if (s.bbCloses.length > BB_PERIOD) s.bbCloses.shift();
  let lowerBB: number | null = null;
  s.midBB = null;
  if (s.bbCloses.length === BB_PERIOD) {
    const mean = s.bbCloses.reduce((a, x) => a + x, 0) / BB_PERIOD;
    const variance = s.bbCloses.reduce((a, x) => a + (x - mean) ** 2, 0) / BB_PERIOD;
    const std = Math.sqrt(variance);
    s.midBB = mean;
    lowerBB = mean - BB_MULT * std;
  }

  // ── exits ────────────────────────────────────────────────────────────────────
  if (rsiVal !== null && rsiVal > RSI_EXIT) return 'down';
  if (s.midBB !== null && c > s.midBB) return 'down'; // price returned to mean
  if (hist !== null && prevHist !== null && hist < 0 && prevHist >= 0) return 'down'; // MACD fades

  // ── entry guards ─────────────────────────────────────────────────────────────
  // Need all indicators warmed up
  if (s.emaFast.value === null || s.emaSlow.value === null) return null;
  if (rsiVal === null || hist === null || lowerBB === null) return null;
  if (atrVal === null || c <= 0) return null;

  // Volatility gate: skip if market is completely flat (fees dominate)
  if ((atrVal / c) * 10_000 < ATR_MIN_BPS) return null;

  // Regime filter
  const ratio = s.emaFast.value / s.emaSlow.value;
  if (ratio < DOWNTREND_RATIO) return null; // downtrend → no entry

  // Entry: ALL three must be true
  // 1. Deeply oversold RSI
  if (rsiVal >= RSI_ENTRY) return null;
  // 2. Price below lower Bollinger Band (statistically cheap)
  if (c >= lowerBB) return null;
  // 3. MACD histogram just crossed from ≤0 to >0 (momentum turning)
  if (!(hist > 0 && prevHist !== null && prevHist <= 0)) return null;

  return 'up';
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
  if (val * STOP_D   <= held.cost * STOP_N)   return true; // −1.2% stop
  if (val * TARGET_D >= held.cost * TARGET_N) return true; // +2.0% target
  const entry = entrySeq.get(symbol);
  if (entry !== undefined && currentSeq - entry >= MAX_HOLD) return true;
  return false;
}

// ── main loop ─────────────────────────────────────────────────────────────────────

await runBars({
  onBatch(state: BarsState, batch) {
    const signals = new Map<string, Signal>();
    for (const bar of batch.bars) {
      signals.set(bar.symbol, computeSignal(bar, getSeries(bar.symbol)));
    }

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
          cooldownUntil.set(symbol, batch.seq + COOLDOWN);
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
