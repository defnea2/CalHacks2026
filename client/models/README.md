# Bundled models

| File | What | Source | sha256 |
| --- | --- | --- | --- |
| `smart-turn-v3.2-cpu.onnx` (8.7 MB) | Pipecat Smart Turn v3.2, int8-quantised CPU build (Whisper Tiny encoder + linear head). Input `input_features` float32 [1, 80, 800] (8 s log-mel), output `logits` [1, 1] = P(turn complete) (already a sigmoid) | `https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-cpu.onnx` | `2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f` |

Licence: BSD 2-Clause, © Daily (model weights per the Hugging Face model card, code per the
`pipecat-ai/smart-turn` repo); the notice is in `LICENSE-smart-turn`, which must ship with any
redistribution (the Vite plugin serves it next to the model under `/vad/`). It is committed rather
than fetched on install because it is small (< 10 MB), redistributable, and the client must work
offline (headless Chrome in the E2E harness, unreliable networks).
