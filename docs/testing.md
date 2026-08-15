# Testing

The default test command stays deterministic and offline:

```sh
npm test
```

Provider compatibility checks are kept in a separate live suite so normal local
and CI runs do not call Nous Portal accidentally:

```sh
npm run test:compat
```

Without the required environment variables, every compatibility test is reported
as skipped by `node:test`.

## Live compatibility environment

Set these values to run the live Nous OpenAI-compatible endpoint checks:

- `NOUS_API_KEY`: Nous inference API key.
- `NOUS_COMPAT_MODEL`: text/tool-capable model to use for most checks.
- `NOUS_INFERENCE_BASE_URL`: optional override; defaults to
  `https://inference-api.nousresearch.com/v1`.
- `NOUS_COMPAT_VISION_MODEL`: explicit vision-capable model for image input and
  image tool-result checks.
- `NOUS_COMPAT_RUN_CONTEXT_OVERFLOW`: opt-in flag for the expensive context
  overflow request.
- `NOUS_COMPAT_CONTEXT_CHARS`: optional approximate character count for the
  context overflow payload; defaults to `600000`.

Example:

```sh
NOUS_API_KEY=... \
NOUS_COMPAT_MODEL=openai/gpt-5.5 \
npm run test:compat
```

Run the vision checks only when you have selected a model that accepts image
input:

```sh
NOUS_API_KEY=... \
NOUS_COMPAT_MODEL=openai/gpt-5.5 \
NOUS_COMPAT_VISION_MODEL=openai/gpt-5.5 \
npm run test:compat
```

The context overflow check intentionally sends a very large prompt and is not
included in ordinary live runs:

```sh
NOUS_API_KEY=... \
NOUS_COMPAT_MODEL=openai/gpt-5.5 \
NOUS_COMPAT_RUN_CONTEXT_OVERFLOW=1 \
npm run test:compat
```

## Coverage map

The files under `tests/compat/` mirror omp's provider-compatibility categories:

- `stream.test.mjs`: basic completion, streamed text, and streamed tool calls.
- `tokens.test.mjs`: streamed abort behavior and token usage expectations.
- `abort.test.mjs`: immediate and mid-stream abort behavior plus recovery.
- `empty.test.mjs`: empty, whitespace, and empty-assistant-message handling.
- `context-overflow.test.mjs`: explicit opt-in context limit rejection.
- `image-limits.test.mjs`: small inline image input for a vision model.
- `unicode-surrogate.test.mjs`: emoji and unpaired surrogate content in a tool
  result.
- `tool-call-without-result.test.mjs`: orphaned tool call handling and sanitized
  follow-up behavior.
- `image-tool-result.test.mjs`: image content returned from a tool result.
- `total-tokens.test.mjs`: native OpenAI-compatible token accounting.
- `cross-provider-handoff.test.mjs`: handoff-like replay of prior assistant and
  tool-result messages.

The live suite is dependency-free and talks directly to the provider's
OpenAI-compatible `/chat/completions` endpoint. It validates the remote Nous
contract without adding omp itself as a development dependency.
