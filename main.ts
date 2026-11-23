// Early Momentum Hold — BTC race 24h (btc-race-24h-20261123-0511)
//
// Idea, from the dev window's shape: the whole 24h rise came from one
// fast leg early in the window, then ~18h of sideways chop. A bot that
// waits for a slow confirmation (15-minute EMA crosses) arrives after
// the leg is over and buys the top of the chop. A bot that is already
// long before the leg keeps the whole move.
//
// So this bot does one thing: get long early on a short, honest
// momentum read, then hold with a loose trailing stop and no fixed
// take-profit (a fixed TP sells mid-leg and never gets back in).
//
// Rules, in plain words:
//   - Once every 24 bars (batch 24, 48, 72, ...), look at the trailing
//     24-bar return of CBBTC. If flat (no position) and the return is
//     not negative, buy with all available cash, in a single order.
//   - While long, remember the highest close seen since entry. If the
//     latest close falls 2% or more below that peak, sell everything.
//   - After a stop-out, stay flat for the rest of the window: one
//     round trip at most, so fees (~26 bps per round trip) cannot
//     bleed the entry through chop.
//   - No signal is ever taken from a single 1-minute bar, no
//     dip-buying, no breakout of a highest high, no take-profit.
//   - Deterministic: decisions depend only on the closes the harness
//     sent (the bar time in each batch), never on the wall clock,
//     the network, or files outside this repository.
//
// The numbers (24 bars, 2% trail, 100 bps max slippage) are the
// strategy's own; the trailing-24-bar read is the same family of
// signal the kit's momentum baseline uses, but the entry gate, the
// exit, the sizing and the one-round-trip cap are written here from
// scratch for this window.

import { runBars, type BarsState, type OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";

// How far back the momentum read looks, and how often it is re-checked.
const LOOKBACK_BARS = 24;
// Sell everything once the close has fallen this far below the peak
// close seen since entry (2% = 200 bps).
const TRAIL_STOP_BPS = 200;
const BPS_DENOM = 10_000;
// Cap the fill's distance from the latest close we were sent.
const MAX_SLIPPAGE_BPS = 100;

// Latest close per batch seq (null before the symbol's first bar).
const closes: (bigint | null)[] = [];
// Highest close seen while long; null while flat.
let peakClose: bigint | null = null;
// True once the trailing stop has fired; after that we never re-enter.
let stoppedOut = false;

/** Trailing 24-bar return as of batch `seq`: latest close vs the close 24 bars back. */
function trailingReturnNonNegative(seq: number): boolean {
  const now = closes[seq];
  const then = closes[seq - LOOKBACK_BARS];
  if (now === null || now === undefined || then === null || then === undefined) return false;
  return now >= then;
}

await runBars({
  onBatch(state: BarsState, batch): OrderInput[] {
    const close = state.close(SYMBOL);
    closes[batch.seq] = close;
    if (close === null || state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      // Long: track the peak, then check the trailing stop.
      if (peakClose === null || close > peakClose) peakClose = close;
      // Sell all once close <= peak * (1 - 2%).
      if (peakClose !== null && close * BigInt(BPS_DENOM) <= peakClose * BigInt(BPS_DENOM - TRAIL_STOP_BPS)) {
        peakClose = null;
        stoppedOut = true;
        return [{ side: "sell", symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: only a 24-bar checkpoint may open a position, only once,
    // and only when the trailing 24-bar return is not negative.
    if (stoppedOut) return [];
    if (batch.seq < LOOKBACK_BARS || batch.seq % LOOKBACK_BARS !== 0) return [];
    if (!trailingReturnNonNegative(batch.seq)) return [];

    const room = state.weightRoom(SYMBOL);
    const spend = state.cash < room ? state.cash : room;
    if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    peakClose = close;
    return [{ side: "buy", symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
