# Model discovery and pricing

`omp-nous-portal-provider` uses omp's native `fetchDynamicModels` provider hook. Omp fetches the catalog through its shared SQLite model cache (24-hour default TTL), rather than storing a second copy inside OAuth credentials.

## Source of truth

The plugin fetches:

```text
<NOUS_INFERENCE_BASE_URL>/models
```

The endpoint currently permits unauthenticated catalog reads. When omp has a direct API key or Portal OAuth token, the plugin includes it as `Authorization: Bearer …`.

The Nous response is authoritative for model availability, discounted pricing, context limits, supported inputs, and reasoning support. The plugin does **not** replace these values with OpenRouter's catalog: OpenRouter reports upstream list prices and would overstate Nous's discounted cost.

Non-chat entries whose `architecture.output_modalities` do not contain `text` (for example embedding models) are excluded from omp's chat model picker.

## Field mapping

| Nous `/models` field | Omp model field | Conversion |
| --- | --- | --- |
| `id` | `id` | unchanged |
| `name` | `name` | unchanged; falls back to `id` |
| `pricing.prompt` | `cost.input` | USD/token × 1,000,000 |
| `pricing.completion` | `cost.output` | USD/token × 1,000,000 |
| `pricing.input_cache_read` | `cost.cacheRead` | USD/token × 1,000,000 |
| `pricing.input_cache_write` | `cost.cacheWrite` | USD/token × 1,000,000 |
| `context_length` | `contextWindow` | tokens, unchanged |
| `top_provider.max_completion_tokens` | `maxTokens` | tokens, unchanged |
| `architecture.input_modalities` | `input` | maps `text` and `image`; unsupported modalities are ignored |
| `supported_parameters` | `reasoning` | true for `reasoning` or `include_reasoning` |

`pricing.original` is the pre-discount list price. It is deliberately not used for `cost`: omp displays the rate the Nous account is actually charged.

Example: Nous `prompt: "0.000004"` maps to `$4.00/M` input tokens in omp, not `$0.000004/M`.

## Wire selection

Nous Portal exposes an OpenAI-compatible inference API:

All catalog IDs use Nous Portal's OpenAI-compatible `/v1/chat/completions`
endpoint with `Authorization: Bearer <credential>`. Model IDs are forwarded
unchanged.
