// Hot-launch rider for the pump.fun bot sprint.
// Run by the grader as `node /bot/main.ts`. The strategy lives in
// strategy.ts; the protocol shim is the kit's vendored SDK
// (vendor/makefun-bot.ts, a byte-identical copy of the kit's sdk/ts file).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy(state, batch),
});
