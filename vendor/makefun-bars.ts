// agent-fun/bars-replay/v1 bot shim for Node 22: one file, erasable TypeScript, node:readline only, so
// it runs as-is under the grader's `node /bot/main.ts`. Copy it to vendor/makefun-bars.ts in your
// repository and hand runBars your strategy:
//
//   import { runBars } from './vendor/makefun-bars.ts';
//   await runBars({
//     onBatch(state, batch) {            // once per bar: the orders decided on it
//       return [{ side: 'buy', symbol: 'SOL', notional_quote_units: state.cash / 10n, max_slippage_bps: 100 }];
//     },
//   });                                  // optional: onHello(state), onDone(state, done)
//
// The shim owns the wire: one JSON line at a time from stdin, `state` kept current (account, positions,
// every symbol's latest bar: its close and its pool depth), exactly one reply per batch on stdout
// echoing its seq, before the next line is read. Amounts may be bigint, u64 decimal strings or safe
// integers; client_id is filled in when left out. What the harness would call a protocol violation
// (an unknown key, a malformed symbol, amount, bps or client_id, a client_id starting with `_`, a
// reply over MAX_BOT_LINE_BYTES) throws OrderError here, and so do more orders than
// hello.caps.max_orders_per_bar, so a broken bot fails on your machine and not in grading. What the
// market refuses (cash, caps, slippage, no bar) is no error: it comes back in the next batch's fills
// as status "rejected" with a reason.
//
// Market model (contracts/bars-protocol.ts): orders decided on bar k fill at bar k + 1's open, moved by
// the modelled slippage and by constant-product price impact against that bar's pool depth, so size
// costs: a trade worth a USDC meets the factor 1 + a/D1 (+ a/D2 for a SOL-quoted asset's SOL/USDC leg),
// and the orders of one symbol at one open together pay what their sum would. Every bar carries the
// pool depth at its open and its close (o_depth, c_depth: USDC raw units per hop); the fills a batch
// carries were priced at its bars' o and o_depth. state.depthAt(symbol) is the latest close's depth,
// the best guess at the next open's, and state.impactBps(symbol, amount) what a trade worth amount
// would pay there; max_slippage_bps bounds the move from the latest close, the slippage and the
// impact together. A sell's proceeds never fund a buy of the same reply; the last bar's orders are
// rejected (after_end) and every position is flattened at the end, at its latest close against that
// close's depth. stdout carries replies only (diagnostics: console.error). Every entry runs twice
// and the two action logs must match byte for byte: never read the clock, the environment or
// Math.random; seed any randomness from state.hello.seed.

import { createInterface } from 'node:readline';

export const PROTOCOL = 'agent-fun/bars-replay/v1';
/** Harness -> bot lines are at most this many UTF-8 bytes, the `\n` not counted (1 MiB). */
export const MAX_HARNESS_LINE_BYTES = 1_048_576;
/** Bot -> harness lines (replies) are at most this many UTF-8 bytes, the `\n` not counted (64 KiB). */
export const MAX_BOT_LINE_BYTES = 65_536;
/** Basis points per unit: 10_000 bps = 100%. */
export const BPS = 10_000n;
export const U64_MAX = 18_446_744_073_709_551_615n;
/** USDC raw units per USDC (6 decimals): the unit of every pool depth. */
export const USDC_RAW = 1_000_000n;

// ---------------------------------------------------------------- wire types (contracts/bars-protocol.ts)

/** A u64 as a canonical decimal string; read it with BigInt. */
export type U64 = string;
export type Side = 'buy' | 'sell';
/** A universe symbol: its ticker, mint and scales (price p is p / 10^price_scale USDC per unit; qty q is q / 10^qty_scale units). */
export interface HelloSymbol { symbol: string; mint: string; price_scale: number; qty_scale: number }
export interface Capital { quote: 'USDC'; quote_scale: number; quote_units: U64 }
export interface Caps { max_open_positions: number; max_orders_per_bar: number; max_weight_bps: number; shorts: false; leverage: false }
export interface Fees { fee_bps: number; slippage_bps: number; min_notional_quote_units: U64 }
export interface Hello {
  type: 'hello'; protocol: typeof PROTOCOL; seed: U64; symbols: HelloSymbol[]; capital: Capital;
  bar_interval: '1m' | '1h' | '1d'; first_close_ms: number; caps: Caps; fees: Fees; latency_bars: 1;
}
/**
 * One symbol's bar closing at t (ms); prices at its price_scale, v at its qty_scale or null; the pool
 * depth at o and at c, one per hop of the symbol's price path (its pool, then a SOL-quoted asset's
 * SOL/USDC leg), in USDC raw units (10^-6 USDC).
 */
export interface Bar { symbol: string; t: number; o: U64; h: U64; l: U64; c: U64; v: U64 | null; o_depth: U64[]; c_depth: U64[] }
export interface Position { symbol: string; qty: U64; cost_quote_units: U64 }
export interface Account { cash_quote_units: U64; positions: Position[]; equity_quote_units: U64 }
export const REJECT_REASONS = [
  'max_open_positions', 'max_orders_per_bar', 'max_weight', 'insufficient_cash', 'insufficient_position', 'not_in_universe',
  'no_bar', 'zero_amount', 'duplicate_client_id', 'below_min_notional', 'max_slippage', 'after_end',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];
export interface Fill {
  client_id: string; symbol: string; side: Side; status: 'filled' | 'rejected'; reason: RejectReason | null;
  decided_bar: number; fill_bar: number; price: U64; qty: U64; notional_quote_units: U64; fee_quote_units: U64;
}
export interface Batch { type: 'batch'; seq: number; t: number; bars: Bar[]; fills: Fill[]; account: Account }
export interface Done { type: 'done'; seq: number; reason: 'end_of_data' | 'aborted'; account: Account }
export type HarnessMessage = Hello | Batch | Done;
export interface BuyOrder { side: 'buy'; client_id: string; symbol: string; notional_quote_units: U64; max_slippage_bps: number }
export interface SellOrder { side: 'sell'; client_id: string; symbol: string; qty: U64; max_slippage_bps: number }
export type Order = BuyOrder | SellOrder;
export interface Reply { type: 'reply'; seq: number; orders: Order[] }

/** bigint, a u64 decimal string, or a non-negative safe integer. */
export type Amount = bigint | string | number;
/** A buy: cash to spend, fee included. client_id (1-64 of [A-Za-z0-9_-], not starting with `_`) is assigned when omitted. */
export interface BuyInput { side: 'buy'; symbol: string; notional_quote_units: Amount; max_slippage_bps: number; client_id?: string }
/** A sell: asset units at the symbol's qty_scale. */
export interface SellInput { side: 'sell'; symbol: string; qty: Amount; max_slippage_bps: number; client_id?: string }
export type OrderInput = BuyInput | SellInput;

/** The harness sent something this shim cannot follow. */
export class ProtocolError extends Error {
  override name = 'ProtocolError';
}
/** The bot returned something the harness would treat as a protocol violation. */
export class OrderError extends Error {
  override name = 'OrderError';
}

const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const SYMBOL_RE = /^[A-Z0-9]{1,20}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;
const KEYS = { buy: ['side', 'client_id', 'symbol', 'notional_quote_units', 'max_slippage_bps'], sell: ['side', 'client_id', 'symbol', 'qty', 'max_slippage_bps'] };

/** Everything the bot knows, current before each callback. Unit-test a strategy with `s = new BarsState(hello); s.applyBatch(b)`. */
export class BarsState {
  readonly hello: Hello;
  /** Seq and close time of the batch being answered (-1 before the first). */
  seq = -1;
  t = -1;
  account: Account;
  /** The account's cash and equity (cash plus every position at its latest close) as bigints. */
  cash: bigint;
  equity: bigint;
  /** Held quantities and their cost (fees included), by symbol. */
  readonly positions = new Map<string, { qty: bigint; cost: bigint }>();
  /** Each symbol's latest bar, however many bars back; absent until its first. */
  readonly latest = new Map<string, Bar>();
  readonly symbols = new Map<string, HelloSymbol>();
  #used = new Set<string>();
  #next = 1;

  constructor(hello: Hello) {
    this.hello = hello;
    this.cash = this.equity = BigInt(hello.capital.quote_units);
    this.account = { cash_quote_units: hello.capital.quote_units, positions: [], equity_quote_units: hello.capital.quote_units };
    for (const s of hello.symbols) this.symbols.set(s.symbol, s);
  }

  /** The symbol's latest close, or null before its first bar (a buy then is rejected no_bar). */
  close(symbol: string): bigint | null {
    const b = this.latest.get(symbol);
    return b === undefined ? null : BigInt(b.c);
  }

  /** What `qty` of the symbol is worth at `price` (default its latest close), truncated, in quote units. */
  value(symbol: string, qty: bigint, price: bigint | null = this.close(symbol)): bigint {
    const s = this.symbols.get(symbol);
    if (s === undefined || price === null) return 0n;
    return (qty * price * 10n ** BigInt(this.hello.capital.quote_scale)) / 10n ** BigInt(s.qty_scale + s.price_scale);
  }

  /** The pool depth at the symbol's latest close (its latest bar's c_depth: per hop, USDC raw units), or null before its first bar. */
  depthAt(symbol: string): bigint[] | null {
    const b = this.latest.get(symbol);
    return b === undefined ? null : b.c_depth.map((d) => BigInt(d));
  }

  /**
   * The price impact in bps, truncated, of one trade worth `amount` quote units (a buy's spend after
   * the fee, a sell's quantity at the open) on the pool depthAt(symbol), untouched: (M - 1) x 10000
   * for M = 1 + a/D1 + a/D2, a in USDC raw units. A buy pays the slipped open times M, a sell gets it
   * divided by M. Null before the symbol's first bar.
   */
  impactBps(symbol: string, amount: bigint): bigint | null {
    const depth = this.depthAt(symbol);
    if (depth === null) return null;
    // 1/D1 + 1/D2 = (D2 + D1) / (D1 D2): the sum of each depth's complement over their product.
    const prod = depth.reduce((p, d) => p * d, 1n);
    const sum = depth.reduce((s, _d, i) => s + depth.reduce((p, d, j) => (j === i ? p : p * d), 1n), 0n);
    return (amount * USDC_RAW * BPS * sum) / (10n ** BigInt(this.hello.capital.quote_scale) * prod);
  }

  /** The most a buy of the symbol may spend in one reply under caps.max_weight_bps (before other buys of it). */
  weightRoom(symbol: string): bigint {
    const room = (BigInt(this.hello.caps.max_weight_bps) * this.equity) / BPS - this.value(symbol, this.positions.get(symbol)?.qty ?? 0n);
    return room > 0n ? room : 0n;
  }

  /** A fresh client_id (o1, o2, ...) never used in this run. */
  clientId(): string {
    const id = this.#freeId(new Set());
    this.#used.add(id);
    return id;
  }

  /** Fold a batch in (bars, then the account). runBars calls this. */
  applyBatch(batch: Batch): void {
    this.seq = batch.seq;
    this.t = batch.t;
    for (const b of batch.bars) this.latest.set(b.symbol, b);
    this.#setAccount(batch.account);
  }

  /** Fold the final account in. runBars calls this before onDone. */
  applyDone(done: Done): void {
    this.seq = done.seq;
    this.#setAccount(done.account);
  }

  /** What onBatch returned as wire orders (missing client_ids assigned); throws OrderError on a violation or too many orders. */
  toOrders(result: unknown): Order[] {
    if (result === undefined || result === null) return [];
    if (!Array.isArray(result)) throw new OrderError(`batch ${this.seq}: onBatch must return an array of orders, got ${describe(result)}`);
    const cap = this.hello.caps.max_orders_per_bar;
    if (result.length > cap) throw new OrderError(`batch ${this.seq}: onBatch returned ${result.length} orders, over hello.caps.max_orders_per_bar (${cap}): the harness rejects every order past it`);
    const checked = result.map((o: unknown, i: number) => checkOrder(o, `batch ${this.seq} order ${i}`));
    const taken = new Set(checked.flatMap((o) => (o.client_id === undefined ? [] : [o.client_id])));
    return checked.map((o): Order => {
      const client_id = o.client_id ?? this.#freeId(taken);
      taken.add(client_id);
      return o.side === 'buy'
        ? { side: 'buy', client_id, symbol: o.symbol, notional_quote_units: o.amount, max_slippage_bps: o.bps }
        : { side: 'sell', client_id, symbol: o.symbol, qty: o.amount, max_slippage_bps: o.bps };
    });
  }

  /** Record orders as sent: their ids are never assigned again. */
  recordOrders(orders: readonly Order[]): void {
    for (const o of orders) this.#used.add(o.client_id);
  }

  #freeId(taken: Set<string>): string {
    for (;;) {
      const id = `o${this.#next++}`;
      if (!this.#used.has(id) && !taken.has(id)) return id;
    }
  }

  #setAccount(account: Account): void {
    this.account = account;
    this.cash = BigInt(account.cash_quote_units);
    this.equity = BigInt(account.equity_quote_units);
    this.positions.clear();
    for (const p of account.positions) this.positions.set(p.symbol, { qty: BigInt(p.qty), cost: BigInt(p.cost_quote_units) });
  }
}

function checkOrder(value: unknown, where: string): { side: Side; client_id: string | undefined; symbol: string; amount: U64; bps: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new OrderError(`${where}: expected an order object, got ${describe(value)}`);
  const o = value as Record<string, unknown>;
  if (o.side !== 'buy' && o.side !== 'sell') throw new OrderError(`${where}: side must be "buy" or "sell", got ${describe(o.side)}`);
  const keys = KEYS[o.side];
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new OrderError(`${where}: unknown key "${k}" on a ${o.side} order`);
  if (typeof o.symbol !== 'string' || !SYMBOL_RE.test(o.symbol)) throw new OrderError(`${where}: symbol must be a ticker of 1-20 [A-Z0-9], got ${describe(o.symbol)}`);
  const amountKey = keys[3]!;
  const amount = toU64(o[amountKey], `${where}: ${amountKey}`);
  const bps = o.max_slippage_bps;
  if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new OrderError(`${where}: max_slippage_bps must be an integer 0..10000, got ${describe(bps)}`);
  if (o.client_id !== undefined && (typeof o.client_id !== 'string' || !CLIENT_ID_RE.test(o.client_id))) {
    throw new OrderError(`${where}: client_id must be 1-64 of [A-Za-z0-9_-] not starting with _ (reserved for the harness's closes), got ${describe(o.client_id)}`);
  }
  return { side: o.side, client_id: o.client_id as string | undefined, symbol: o.symbol, amount, bps };
}

/** An amount as a canonical u64 decimal string; throws OrderError when it is not one. */
export function toU64(value: unknown, what = 'amount'): U64 {
  let n: bigint | null = null;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === 'string' && U64_RE.test(value)) n = BigInt(value);
  if (n === null || n < 0n || n > U64_MAX) throw new OrderError(`${what} must be a u64 (bigint, decimal string or safe integer), got ${describe(value)}`);
  return n.toString();
}

function describe(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'string') return JSON.stringify(value.length > 80 ? `${value.slice(0, 77)}...` : value);
  if (value === null || typeof value !== 'object') return String(value);
  return Array.isArray(value) ? 'an array' : 'an object';
}

// ---------------------------------------------------------------- the line loop

/** Where replies go (process.stdout by default); a false from write() waits for 'drain' when once() exists. */
export interface LineWriter {
  write(chunk: string): unknown;
  once?(event: 'drain', listener: () => void): unknown;
}
export type OrdersResult = readonly OrderInput[] | void | null | undefined;
export interface Bot {
  onHello?(state: BarsState): void | Promise<void>;
  onBatch(state: BarsState, batch: Batch): OrdersResult | Promise<OrdersResult>;
  /** After the final account (flattened) took effect; no reply is sent. */
  onDone?(state: BarsState, done: Done): void | Promise<void>;
}

/**
 * Speak agent-fun/bars-replay/v1 until done, then stop reading and resolve (the process exits once
 * stdout drains, even with stdin left open). Rejects with ProtocolError, OrderError or what a callback
 * threw; unhandled, that ends the process with exit code 1.
 */
export async function runBars(bot: Bot, io: { input?: NodeJS.ReadableStream; output?: LineWriter } = {}): Promise<{ state: BarsState; done: Done; batches: number }> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const encoder = new TextEncoder();
  const lines = createInterface({ input, crlfDelay: Infinity });
  let state: BarsState | null = null;
  let lineNo = 0;
  try {
    for await (const line of lines) {
      lineNo++;
      if (encoder.encode(line).byteLength > MAX_HARNESS_LINE_BYTES) throw new ProtocolError(`input line ${lineNo} is over ${MAX_HARNESS_LINE_BYTES} bytes`);
      if (line.trim() === '') continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        throw new ProtocolError(`input line ${lineNo} is not JSON`);
      }
      const type = typeof msg === 'object' && msg !== null ? msg.type : undefined;
      if (type === 'hello') {
        if (state !== null) throw new ProtocolError(`input line ${lineNo}: a second hello`);
        if (msg.protocol !== PROTOCOL) throw new ProtocolError(`the harness speaks ${describe(msg.protocol)}; this shim speaks ${PROTOCOL}`);
        state = new BarsState(msg as unknown as Hello);
        await bot.onHello?.(state);
      } else if (type === 'batch' || type === 'done') {
        if (state === null) throw new ProtocolError(`input line ${lineNo}: ${type} before hello`);
        const a = msg.account as Account | undefined;
        const shaped = msg.seq === state.seq + 1 && typeof a === 'object' && a !== null && Array.isArray(a.positions);
        if (type === 'done') {
          if (!shaped) throw new ProtocolError(`input line ${lineNo}: malformed done (seq ${describe(msg.seq)} after batch ${state.seq})`);
          const done = msg as unknown as Done;
          state.applyDone(done);
          await bot.onDone?.(state, done);
          return { state, done, batches: done.seq };
        }
        if (!shaped || !Number.isSafeInteger(msg.t) || !Array.isArray(msg.bars) || !Array.isArray(msg.fills)) throw new ProtocolError(`input line ${lineNo}: malformed batch (seq ${describe(msg.seq)} after ${state.seq})`);
        const batch = msg as unknown as Batch;
        state.applyBatch(batch);
        const orders = state.toOrders(await bot.onBatch(state, batch));
        const text = JSON.stringify({ type: 'reply', seq: batch.seq, orders } satisfies Reply);
        const bytes = encoder.encode(text).byteLength;
        if (bytes > MAX_BOT_LINE_BYTES) throw new OrderError(`batch ${batch.seq}: the reply is ${bytes} bytes (max ${MAX_BOT_LINE_BYTES})`);
        state.recordOrders(orders);
        if (output.write(`${text}\n`) === false && output.once) await new Promise<void>((resolve) => output.once!('drain', resolve));
      } else throw new ProtocolError(`input line ${lineNo}: unknown message type ${describe(type)}`);
    }
  } finally {
    lines.close();
    if (input === process.stdin) process.stdin.destroy();
  }
  throw new ProtocolError(state === null ? 'input ended before hello' : `input ended before done (after ${state.seq + 1} batches)`);
}
