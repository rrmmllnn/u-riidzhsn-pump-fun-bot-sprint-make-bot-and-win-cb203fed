[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rrmmllnn/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rrmmllnn/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Hot-Launch Rider — Pump.fun Bot Sprint

A Solana trading bot for the [Pump.fun Bot Sprint](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) on make.fun. It trades paper SOL on a replay of pump.fun bonding-curve events, ranked on net PnL.

## Idea

A launch's price can barely fall below its create price — the 30 SOL of virtual reserves dwarfs real trade sizes — while a few launches run 5–15x to graduation. So the edge is not in catching small moves (the 1.25% curve fee each way eats them) but in buying the few genuinely hot launches and riding them with a wide trailing stop.

- **Hot tier:** 15 slots after a launch, if 4–10 distinct wallets (not the creator) have bought it, the creator has not sold, and the curve holds 1–30 SOL of real reserves, buy 0.10 SOL. Exit on a 25% stop loss, a 35% fall from the best value once up 50% (trailing stop), 2,000 slots held, or a creator sell. No fixed take-profit — the dev window's one runner paid +0.45 SOL because it ran to ~10x before the trail caught it.
- **Probe tier:** any other launch with 1–20 buyers and ≥1 SOL real reserves gets a 0.02 SOL probe that exits fast (+20% / −15% / 100 slots), keeping the run above the 20-coin guardrail on a shorter final window. Probes never take the last open-position slot.

## Dev-window result (kit's local simulator, full 24h dev dataset)

- **Net PnL: +0.316 SOL** (halves +0.020 / +0.296), 195 fills, 98 coins traded, 97 with a full 0.01+ SOL round trip, max drawdown 3.2%.
- Baselines on the same data: sniper −0.49 SOL, reversion −1.64 SOL, momentum −9.38 SOL.

## Files

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts`.
- `strategy.ts` — the strategy (hot tier + probe tier).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte-identical.

## Run locally

```sh
node cli/makefun.mjs grade-local --kit <kit dir> --bot <this repo> --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=5hwq4sqk&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
