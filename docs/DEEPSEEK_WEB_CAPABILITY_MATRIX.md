# DeepSeek Web Capability Matrix

This document records observations for the `chat.deepseek.com` Web bridge. It is not an official DeepSeek API specification and must be refreshed when the upstream settings payload or account changes.

## What Is Known

| Dimension | Current bridge behavior | Evidence / boundary |
|---|---|---|
| Model IDs | Derived from `GET /api/v0/client/settings?scope=model` | No hard-coded fallback list; last successful settings result is the source for capability metadata |
| Upstream model type | `model_type` from settings | Resolver uses the cached settings match before name heuristics |
| Thinking | Settings `think_feature` controls support; `thinking_enabled` is a binary upstream switch | `reasoning_effort=medium/high/max` currently means enabled, not a measured depth budget |
| File / vision / search | Exposed only when the settings payload declares the corresponding feature | Unsupported capabilities are not advertised as enabled |
| Context window | Reported only when settings provides a numeric context field | The bridge does not invent an official context size |
| Output limit | Reported only when settings provides a numeric output field | Requested and observed limits still need live measurement |
| Web session | A new `chatSessionId` is created for every request and retry | `parent_message_id` remains `null` |
| Prompt guard | UTF-8 byte budget: soft default `180000`, hard default `200000` | Hard limit rejects before session/PoW; soft limit disables meaningless retries |
| SSE completion | Requires `FINISHED` or `[DONE]` | Normal EOF without a terminal event is `UPSTREAM_STREAM_INCOMPLETE` |

## Observed Context Baseline

The existing manual probe recorded the following result on 2026-07-07 for DeepSeek Expert through the bridge:

| Input size | Result |
|---:|---|
| ~10K tokens | Real streamed response completed |
| 50K+ tokens | HTTP 200 with an empty upstream SSE payload |

This is an observed Web limit, not a promise about an official DeepSeek API context window. A short response or a client abort must be distinguished from an upstream empty stream in logs and tests.

## Response Headers

Successful DeepSeek requests may expose:

- `x-dpsk-model-type`
- `x-dpsk-thinking-enabled`
- `x-dpsk-capability-source` (`settings` or `heuristic`)
- `x-dpsk-context-window` when settings provides one
- `x-dpsk-max-output-tokens` when settings provides one
- `x-dpsk-requested-max-tokens` and `x-dpsk-applied-max-tokens`
- `x-dpsk-prompt-bytes`, `x-dpsk-prompt-soft-limit-bytes`, and `x-dpsk-prompt-hard-limit-bytes` on Chat requests

These fields are diagnostic hints, not contractual proof that the Web endpoint will honor every requested token.

## Live Probe Rules

Long-context and soak probes are manual opt-in tests. They must use a dedicated account, record model ID, protocol, input/output sizes, TTFB, terminal event, and failure classification, and must never run in the default unit-test command. Do not store tokens, cookies, complete prompts, tool results, or absolute user paths in fixtures or logs.

The opt-in probe is `scripts/probe-deepseek-web.js`. It creates a fresh Web session for every matrix point and emits redacted JSONL. A minimal run is:

```powershell
$env:ZPROXY_TEST_LOAD_ENV = 'true'
$env:DPSK_PROBE_ENABLE = 'true'
$env:DPSK_PROBE_TOKEN = '<dedicated-test-token>'
$env:DPSK_PROBE_MODEL = 'deepseek-default'
$env:DPSK_PROBE_MAX_CASES = '10'
node scripts/probe-deepseek-web.js
```

The result fields distinguish `done`, `eof_without_done`, `error`, and `client_timeout_abort`, and include `ttfb_ms`, `total_ms`, text/thinking byte counts, requested input/output sizes, and whether a fresh session was created. The probe does not claim a model's official context window; it records the observed Web boundary on the date it ran.
