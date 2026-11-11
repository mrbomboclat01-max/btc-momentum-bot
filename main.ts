// MACD-Histogram Momentum + Oversold-Bounce bot for 1-minute cbBTC/USDC.
//
// Two entry modes — fundamentally different from EMA-crossover strategies:
//
//   MODE A  Oversold Bounce (mean reversion)
//     Fires when price is statistically cheap (Z-score < −1.5 vs 20-bar mean),
//     RSI(14) < 38, and the MACD histogram just turned positive (momentum
//     starting to reverse).  Expects price to snap back toward the mean.
//     Exit: Z-score > 0.4, RSI > 70, MACD histogram turns negative, stop or target.
//
//   MODE B  Momentum Burst (trend following)
//     Fires when the MACD histogram is positive AND accelerating for two
//     consecutive bars AND RSI is in the momentum zone (50–66) AND
//     Bollinger %B > 0.55 (price in the upper half of the bands).
//     Rides the momentum burst until it fades.
//     Exit: MACD histogram cross to negative, RSI > 72, stop or target.
//
//   Volatility gate: ATR(14)/price < 4 bps → skip (flat market, fees dominate).
//   Cooldown: 3 bars after any exit before re-entering.
//   Time-stop: exit after 75 bars regardless.
//   Hard stop: −1.6%.  Take-profit: +2.2%.
//
//   Round-trip cost ≈ 26 bps.  Net target ≈ +1.94%.  Net stop ≈ −1.86%.
//
// Deterministic: float64 IEEE-754 only, no Math.random, no Date, no I/O.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// ── parameters ───────────────────────────────────────────────────────────────────
const BB_PERIOD   = 20;
const BB_MULT     = 2.0;
const MACD_FAST   = 12;
const MACD_SLOW   = 26;
const MACD_SIG    = 9;
const RSI_PERIOD  = 14;
const ATR_PERIOD  = 14;

// Mode A: oversold bounce
const Z_ENTRY_A   = -1.5;  // Z-score below this → price is cheap
const Z_EXIT_A    =  0.4;  // mean-reversion done when Z-score recovers here
const RSI_A_MAX   = 38;    // must be oversold to enter mode A

// Mode B: momentum burst
const RSI_B_LO    = 50;
const RSI_B_HI    = 66;
const BB_B_MIN    = 0.55;  // Bollinger %B above midpoint

// Shared exits
const RSI_EXIT_A  = 70;
const RSI_EXIT_B  = 72;
const ATR_MIN_BPS = 4;     // volatility gate

const COOLDOWN    = 3;
const MAX_HOLD    = 75;

// bigint ratios (cost already includes buy fee)
const STOP_N   = 984n; const STOP_D   = 1000n;  // hard stop −1.6%
const TARGET_N = 1022n; const TARGET_D = 1000n; // take profit +2.2%

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
    const up = d > 0 ? d : 0;
    const dn = d < 0 ? -d : 0;
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
  if (a.prev !== null) {
    tr = Math.max(tr, Math.abs(h - a.prev), Math.abs(l - a.prev));
  }
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

type EntryMode = 'A' | 'B';
type Signal = 'up-A' | 'up-B' | 'down' | null;

interface Series {
  rsi: Rsi;
  atr: Atr;
  macdFast: Ema;
  macdSlow: Ema;
  macdSig:  Ema;
  prevHist: number | null;
  bbCloses: number[];
  mode: EntryMode | null;
}

const allSeries    = new Map<string, Series>();
const cooldownUntil = new Map<string, number>();
const entrySeq     = new Map<string, number>();

function getSeries(symbol: string): Series {
  let s = allSeries.get(symbol);
  if (s === undefined) {
    s = {
      rsi: mkRsi(), atr: mkAtr(),
      macdFast: mkEma(MACD_FAST), macdSlow: mkEma(MACD_SLOW), macdSig: mkEma(MACD_SIG),
      prevHist: null, bbCloses: [], mode: null,
    };
    allSeries.set(symbol, s);
  }
  return s;
}

function computeSignal(bar: Bar, s: Series): Signal {
  const c = Number(bar.c);

  const rsiVal = stepRsi(s.rsi, c);
  const atrVal = stepAtr(s.atr, bar);

  // MACD
  stepEma(s.macdFast, c);
  stepEma(s.macdSlow, c);
  let hist: number | null = null;
  if (s.macdFast.value !== null && s.macdSlow.value !== null) {
    const line = s.macdFast.value - s.macdSlow.value;
    stepEma(s.macdSig, line);
    if (s.macdSig.value !== null) hist = line - s.macdSig.value;
  }
  const prevHist = s.prevHist;
  s.prevHist = hist;

  // Bollinger Bands + Z-score
  s.bbCloses.push(c);
  if (s.bbCloses.length > BB_PERIOD) s.bbCloses.shift();

  let zScore: number | null = null;
  let bbPct:  number | null = null;

  if (s.bbCloses.length === BB_PERIOD) {
    const mean = s.bbCloses.reduce((a, x) => a + x, 0) / BB_PERIOD;
    const variance = s.bbCloses.reduce((a, x) => a + (x - mean) ** 2, 0) / BB_PERIOD;
    const std = Math.sqrt(variance);
    if (std > 0) {
      zScore = (c - mean) / std;
      const lo = mean - BB_MULT * std;
      const hi = mean + BB_MULT * std;
      bbPct  = (c - lo) / (hi - lo);
    }
  }

  // ── exits (checked even when not holding; onBatch gates by position) ──────────
  if (rsiVal !== null) {
    const rsiExitThresh = s.mode === 'A' ? RSI_EXIT_A : RSI_EXIT_B;
    if (rsiVal > rsiExitThresh) return 'down';
  }
  // MACD histogram cross to negative → momentum lost
  if (hist !== null && prevHist !== null && hist < 0 && prevHist >= 0) return 'down';
  // Mode A extra exit: mean reversion done
  if (s.mode === 'A' && zScore !== null && zScore > Z_EXIT_A) return 'down';

  // Volatility gate
  const atrOk = atrVal !== null && c > 0 && (atrVal / c) * 10_000 >= ATR_MIN_BPS;
  if (!atrOk || rsiVal === null || hist === null || zScore === null || bbPct === null) return null;

  // ── Mode A: oversold bounce ───────────────────────────────────────────────────
  if (
    zScore < Z_ENTRY_A &&                          // price statistically cheap
    rsiVal < RSI_A_MAX &&                           // RSI oversold
    hist > 0 &&                                     // MACD histogram just turned positive
    prevHist !== null && prevHist <= 0              // confirmed cross from non-positive
  ) return 'up-A';

  // ── Mode B: momentum burst ────────────────────────────────────────────────────
  if (
    hist > 0 &&                                     // MACD bullish
    prevHist !== null && hist > prevHist &&         // histogram accelerating
    rsiVal >= RSI_B_LO && rsiVal <= RSI_B_HI &&    // RSI momentum zone
    bbPct > BB_B_MIN                                // price in upper half of bands
  ) return 'up-B';

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
  if (val * STOP_D   <= held.cost * STOP_N)   return true; // −1.6% hard stop
  if (val * TARGET_D >= held.cost * TARGET_N) return true; // +2.2% target
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
    const entries: Array<{ symbol: string; mode: EntryMode }> = [];

    for (const { symbol } of state.hello.symbols) {
      if (!signals.has(symbol)) continue;
      const sig  = signals.get(symbol)!;
      const held = state.positions.get(symbol);

      if (held !== undefined) {
        if (shouldExit(state, symbol, held, sig, batch.seq)) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          cooldownUntil.set(symbol, batch.seq + COOLDOWN);
          entrySeq.delete(symbol);
          getSeries(symbol).mode = null;
        }
      } else if (sig === 'up-A' || sig === 'up-B') {
        const cooldown = cooldownUntil.get(symbol) ?? 0;
        if (batch.seq >= cooldown) entries.push({ symbol, mode: sig === 'up-A' ? 'A' : 'B' });
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots    = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake    = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = slots - state.positions.size;
    let cash = state.cash;

    for (const { symbol, mode } of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      entrySeq.set(symbol, batch.seq);
      getSeries(symbol).mode = mode;
      cash -= slice;
      room--;
    }

    return orders;
  },
});
