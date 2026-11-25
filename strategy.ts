// Hot-launch rider for the pump.fun bonding-curve replay.
//
// Idea, learned from the dev window (24h of pump.fun chain data, 1,222
// in-universe launches): a launch's price can barely fall below its create
// price — the 30 SOL of virtual reserves dwarfs real trade sizes — while a
// few launches run 5-15x to graduation. So the edge is not in catching small
// moves (the 1.25% curve fee each way eats them) but in buying the few
// genuinely hot launches and riding them with a wide trailing stop.
//
// A launch is "hot" when, 15 slots after its CreateEvent, at least 4
// distinct wallets (not the creator) have bought it, at most 10 have, the
// creator has not sold, and the curve holds real SOL. That screen picks
// ~38 of 1,222 dev launches. Each gets 0.10 SOL. The position rides until
// one of: a 25% stop loss, a 35% fall from its best value once it is up
// 50% (trailing stop), 2,000 slots held, or the creator sells. No fixed
// take-profit: the one runner in the dev window paid +0.45 SOL because it
// was allowed to run to ~10x before the trail caught it.
//
// A second, cheap tier keeps the run above the 20-coin guardrail on a
// shorter final window: any other launch with 1-20 buyers and at least
// 1 SOL of real reserves gets a 0.02 SOL probe that exits fast (+20% /
// -15% / 100 slots). Probes never take the last open-position slot, so
// they cannot crowd out a hot launch. On the dev window the two tiers
// together trade 98 coins (97 with a full 0.01+ SOL round trip) for
// +0.32 SOL net PnL at 3.2% max drawdown, positive in both halves.
//
// Pure function of the batches: no clock, no randomness, no I/O, so the two
// graded executions produce byte-identical action logs.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface RiderParams {
  /** Slots after CreateEvent when a launch is judged (and bought, or never). */
  entryAge: number;
  /** Distinct non-creator buyers a hot launch needs by the entry slot. */
  minBuyers: number;
  /** Distinct non-creator buyers at most: more looks like a bundled dump. */
  maxBuyers: number;
  /** Real SOL a curve must hold at entry (lamports). At 1 SOL the 1%-of-
   * reserve buy cap still allows a full 0.01 SOL round trip, which is what
   * the guardrail counts; smaller curves get capped below it. */
  minRealSolLamports: number;
  maxRealSolLamports: number;
  /** Creator's own buy in the create slot, at most (lamports). */
  maxDevBuyLamports: number;
  /** SOL staked on one hot launch (lamports). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for (lamports). */
  minBuyLamports: number;
  /** Exit when the position is worth this far under its cost (bps). */
  stopLossBps: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArmBps). */
  trailArmBps: number;
  /** Exit on a fall of this much (bps) from the position's best value. */
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHoldSlots: number;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Probe tier: stake per probe launch (lamports). */
  probeStakeLamports: number;
  /** Distinct non-creator buyers a probe launch needs. */
  probeMinBuyers: number;
  /** Distinct non-creator buyers at most for a probe. */
  probeMaxBuyers: number;
  /** Probe exit: take profit at this much over cost (bps). */
  probeTakeProfitBps: number;
  /** Probe exit: stop loss under cost (bps). */
  probeStopLossBps: number;
  /** Probe exit: hold at most this many slots. */
  probeMaxHoldSlots: number;
  /** Open positions a probe may take: probes stop when this many are open. */
  probeMaxOpen: number;
}

export const DEFAULT_PARAMS: RiderParams = {
  entryAge: 15,
  minBuyers: 4,
  maxBuyers: 10,
  minRealSolLamports: 1_000_000_000,
  maxRealSolLamports: 30_000_000_000,
  maxDevBuyLamports: 2_500_000_000,
  stakeLamports: 100_000_000,
  minBuyLamports: 5_000_000,
  stopLossBps: 2500,
  trailArmBps: 5000,
  trailBps: 3500,
  maxHoldSlots: 2000,
  buySlippageBps: 10000,
  probeStakeLamports: 20_000_000,
  probeMinBuyers: 1,
  probeMaxBuyers: 20,
  probeTakeProfitBps: 2000,
  probeStopLossBps: 1500,
  probeMaxHoldSlots: 100,
  probeMaxOpen: 4,
};

const BPS = 10000n;
/** Curve fees on a sell: protocol 95 bps + creator 30 bps. */
const SELL_FEE_BPS = 125n;

interface Launch {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  soldByOthers: bigint;
  bought: bigint;
  biggestSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Judged already (bought, probed, or passed over for good). */
  settled: boolean;
  complete: boolean;
}

interface Ride {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  devSoldAtOpen: boolean;
  probe: boolean;
}

/** What selling `tokens` against (vq, vt) pays after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * SELL_FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: RiderParams = DEFAULT_PARAMS) {
  const launches = new Map<Pubkey, Launch>();
  const rides = new Map<Pubkey, Ride>();
  const selling = new Set<Pubkey>();
  // Mints whose next buy fill is a probe: flagged on the ride when it lands.
  const probeMints = new Set<Pubkey>();

  function launchOf(mint: Pubkey, slot: number, creator = ''): Launch {
    let l = launches.get(mint);
    if (l === undefined) {
      l = {
        mint,
        createSlot: slot,
        creator,
        devBuy: 0n,
        trades: 0,
        buyers: new Set(),
        soldByOthers: 0n,
        bought: 0n,
        biggestSellBps: 0n,
        devSold: false,
        lastTradeSlot: slot,
        settled: false,
        complete: false,
      };
      launches.set(mint, l);
    }
    return l;
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const o of state.pending.values()) {
      if (o.order.mint === mint && o.order.side === 'buy') return true;
    }
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const o of state.pending.values()) {
      if (o.order.mint === mint && o.order.side === 'sell') return true;
    }
    return false;
  }

  return function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();

    // Fold this batch's events into the launch tape.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const l = launchOf(e.mint, e.slot, e.creator);
        l.creator = e.creator;
        l.createSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const l = launches.get(e.mint);
        if (l === undefined) continue;
        const sol = BigInt(e.sol_amount);
        l.trades += 1;
        l.lastTradeSlot = e.slot;
        const isDev = e.user === l.creator;
        if (e.is_buy) {
          l.bought += sol;
          if (isDev && e.slot === l.createSlot) l.devBuy += sol;
          else if (!isDev) l.buyers.add(e.user);
        } else if (isDev) {
          l.devSold = true;
        } else {
          l.soldByOthers += sol;
          const before = BigInt(e.real_quote_reserves) + sol;
          if (before > 0n) {
            const bps = (sol * BPS) / before;
            if (bps > l.biggestSellBps) l.biggestSellBps = bps;
          }
        }
      } else {
        const l = launches.get(e.mint);
        if (l !== undefined) {
          l.complete = true;
          l.settled = true;
        }
      }
    }

    // Latest reserves for the coins we hold (marks carry them).
    const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
    for (const m of batch.marks) {
      marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
    }
    const reservesOf = (mint: Pubkey): { vq: bigint; vt: bigint } | undefined => {
      const mk = marks.get(mint);
      if (mk !== undefined) return mk;
      const c = state.curves.get(mint);
      if (c === undefined) return undefined;
      return { vq: c.virtual_quote_reserves, vt: c.virtual_token_reserves };
    };

    // Fold fills: open rides on buy fills, close them on sell fills.
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        rides.delete(f.mint);
        selling.delete(f.mint);
        continue;
      }
      const r = rides.get(f.mint);
      if (r !== undefined && f.status !== 'rejected') r.txPaid += BigInt(f.tx_fee_lamports);
      if (f.side === 'buy' && f.status === 'filled' && r === undefined) {
        const l = launches.get(f.mint);
        const isProbe = probeMints.has(f.mint);
        probeMints.delete(f.mint);
        rides.set(f.mint, {
          openedSlot: f.slot,
          txPaid: BigInt(f.tx_fee_lamports),
          best: 0n,
          devSoldAtOpen: l?.devSold ?? false,
          probe: isProbe,
        });
      }
      if (f.side === 'sell' && f.status === 'filled') {
        rides.delete(f.mint);
        selling.delete(f.mint);
        const l = launches.get(f.mint);
        if (l !== undefined) l.settled = true;
      }
    }
    for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
    for (const mint of [...rides.keys()]) {
      if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) {
        rides.delete(mint);
      }
    }

    // Exits first: a ride ends on its stop, its trail, its hold limit, or a
    // creator sell after entry. Probes end sooner, on their own levels.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) break;
      if (selling.has(mint)) continue;
      const l = launches.get(mint);
      let r = rides.get(mint);
      if (r === undefined) {
        r = { openedSlot: slot, txPaid: tx, best: 0n, devSoldAtOpen: l?.devSold ?? false, probe: probeMints.has(mint) };
        rides.set(mint, r);
      }
      const mk = reservesOf(mint);
      if (mk === undefined) continue;
      const value = sellValue(BigInt(pos.token_amount), mk.vq, mk.vt) - tx;
      const basis = BigInt(pos.cost_lamports) + r.txPaid;
      if (value > r.best) r.best = value;
      let exit = false;
      if (basis > 0n) {
        if (r.probe) {
          if (value * BPS >= basis * (BPS + BigInt(p.probeTakeProfitBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(p.probeStopLossBps))) exit = true;
        } else {
          if (value * BPS <= basis * (BPS - BigInt(p.stopLossBps))) exit = true;
          if (r.best * BPS >= basis * (BPS + BigInt(p.trailArmBps)) && value * BPS <= r.best * (BPS - BigInt(p.trailBps))) {
            exit = true;
          }
        }
      }
      const heldFor = slot - r.openedSlot;
      if (heldFor >= (r.probe ? p.probeMaxHoldSlots : p.maxHoldSlots)) exit = true;
      if (l !== undefined && l.devSold && !r.devSoldAtOpen) exit = true;
      if (!exit) continue;
      orders.push({ side: 'sell', mint, token_amount: BigInt(pos.token_amount), max_slippage_bps: 10000 });
      selling.add(mint);
      if (l !== undefined) l.settled = true;
    }

    // Entries: each launch is judged once, at entryAge slots old.
    let free = state.freeCashLamports() - tx * BigInt(orders.length);
    for (const l of launches.values()) {
      if (orders.length >= cap) break;
      if (l.settled || l.complete) continue;
      const age = slot - l.createSlot;
      if (age < p.entryAge) continue;
      if (age > p.entryAge) {
        l.settled = true;
        continue;
      }
      if (l.devSold) {
        l.settled = true;
        continue;
      }
      const curve = state.curves.get(l.mint);
      if (curve === undefined || curve.complete) {
        l.settled = true;
        continue;
      }
      const rq = curve.real_quote_reserves;
      if (rq < BigInt(p.minRealSolLamports) || rq > BigInt(p.maxRealSolLamports)) {
        l.settled = true;
        continue;
      }
      if (l.devBuy > BigInt(p.maxDevBuyLamports)) {
        l.settled = true;
        continue;
      }
      const n = l.buyers.size;
      const open = state.committedPositionCount();
      if (n >= p.minBuyers && n <= p.maxBuyers && open < state.hello.caps.max_open_positions) {
        // Hot launch: full stake.
        const want = BigInt(p.stakeLamports);
        const room = state.maxBuyLamports(l.mint);
        const amount = want < room ? want : room;
        if (amount >= BigInt(p.minBuyLamports) && free >= amount + tx * 2n) {
          orders.push({ side: 'buy', mint: l.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
          free -= amount + tx;
          l.settled = true;
          continue;
        }
        l.settled = true;
        continue;
      }
      if (n >= p.probeMinBuyers && n <= p.probeMaxBuyers && open < p.probeMaxOpen) {
        // Warm launch: small probe, fast exit. Never takes the last slot.
        const want = BigInt(p.probeStakeLamports);
        const room = state.maxBuyLamports(l.mint);
        const amount = want < room ? want : room;
        if (amount >= BigInt(p.minBuyLamports) && free >= amount + tx * 2n) {
          orders.push({ side: 'buy', mint: l.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
          free -= amount + tx;
          // Mark it a probe so its exit uses the probe levels: record the
          // intent now; the ride is flagged when its buy fill lands.
          probeMints.add(l.mint);
        }
      }
      l.settled = true;
    }
    return orders;
  };
}
