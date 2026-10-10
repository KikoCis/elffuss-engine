# Elffuss Engine — an LLM runtime for the browser (WebGPU, GGUF)

Loads a **standard GGUF over HTTP** and runs it in a tab on WebGPU. No server, no account, no
native build step: the weights are read by range requests, the tensors stay on the GPU, and the
tokens come out in the page that opened the model.

It is what Elffuss Claw and Elffuss Code use when you pick a model marked *motor propio*.

```js
import * as motor from './js/provider.js';

motor.models();                 // [{ id, label }] — the entries in js/registro.js
motor.configure('qwen35-0.8b'); // pick one

// Progress arrives as text, one line per stage: reading the index, then the
// upload to the GPU with its percentage.
await motor.load((paso) => console.log(paso));

motor.setSampling({ temperature: 0.7, maxTokens: 256 });

const texto = await motor.chat(
  [{ role: 'user', content: 'Hola, ¿qué tal?' }],   // the conversation so far
  'You are a concise assistant.',                   // system prompt
  (trozo) => document.body.append(trozo),           // called once per token
);
```

`chat()` resolves with the whole answer; the callback is there to paint it as it comes out.
Call `motor.unload()` to give the GPU memory back.

The host serving the weights must answer **range requests** and send `Access-Control-Allow-Origin`.
Hugging Face does both, so any public GGUF works as a URL.

## What it does

- **GGUF straight from the network** (`js/gguf.js`): parses the header and the tensor table, then
  reads the weights in **contiguous spans** — one request pulls many tensors at once and they are
  split up afterwards. Nothing is loaded whole into RAM, which is what lets a model larger than the
  tab's memory budget run at all. Reading tensor by tensor also works, and it is much slower: the
  cost of a weight read is dominated by the round trip, not by its size.
- **Quantised weights on the GPU** (`js/quant-tables.js`, `js/kernels.*.wgsl.js`): the k-quant and
  i-quant blocks are dequantised inside the shader, so the GPU stores the compressed tensor.
- **Hybrid models**: attention and SSM layers (`kernels.attn`, `kernels.ssm`), which is what a
  Qwen3.x hybrid needs — most of its blocks keep a fixed-size state instead of a growing KV cache.
- **Long dispatches are split on purpose** (`js/model.js`): a single long GPU dispatch starves the
  system compositor, and every OS has a watchdog that kills the graphics session when the screen
  stops repainting. The engine yields between batches.
- **Device budget** (`js/device.js`): buffer limits and the practical ceiling per platform, so a
  model that cannot fit is refused early instead of failing halfway.
- **A model that big gets one tab** (`js/provider.js`): past a size threshold the engine takes a
  cross-tab lock *before* fetching anything, so a second tab is told no immediately instead of
  downloading several gigabytes only to be refused — and instead of two copies fighting over the
  same GPU while it happens.
- **The prompt is not re-read every turn** (`js/provider.js`, `js/state.js`): the recurrent state is
  snapshotted so a turn whose prompt starts with the tokens already ingested continues instead of
  starting over. There are two rescue levels, because the strict-prefix case almost never holds once
  an agent injects live state into the prompt: the engine also keeps a snapshot taken right after the
  system block, so a turn that diverges mid-prompt still skips the instructions instead of
  reprocessing them. Reuse is token-exact and falls back to a full restart on any divergence — the
  output is identical either way, which is what the tests assert.

## What is not here

The **offline packer/compressor** and everything about how weights are prepared or calibrated is not
part of this repository and is not published.

## Status

Working, and slow by any native standard: a 27B at IQ1 answers in a tab, it does not feel instant.
Dequantisation is checked **bit for bit** against llama.cpp for every quant type the engine
implements, and the quantised path is checked against an unquantised twin of the same weights, so
the numerics are not guesswork. Agreement with llama.cpp *node by node* through a whole block is
still being chased down, and the discrepancy is in the test harness as much as anywhere — treat
this as a runtime you can read and build on, not as a finished product.

Apache-2.0.
