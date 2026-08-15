# omp-nous-portal-provider

A Nous Research Portal provider for [oh-my-pi](https://github.com/can1357/oh-my-pi). It supports Portal OAuth subscriptions and direct inference API keys.

## Install

```sh
omp plugin install omp-nous-portal-provider
```

## Portal OAuth

Start omp, then run:

```text
/login nous-portal
```

The login flow opens Nous Portal's device authorization page. Omp stores the refresh token in its credential store and refreshes the short-lived inference token when needed.

## Direct API key

Export a Portal inference key before starting omp:

```sh
export NOUS_API_KEY=sk-nous-...
omp --model nous-portal/openai/gpt-5.5
```

You can create an inference key in [Nous Portal](https://portal.nousresearch.com).

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `NOUS_API_KEY` | Direct inference API key | unset |
| `NOUS_PORTAL_BASE_URL` | Portal OAuth and account API | `https://portal.nousresearch.com` |
| `NOUS_INFERENCE_BASE_URL` | OpenAI-compatible inference API | `https://inference-api.nousresearch.com/v1` |
| `NOUS_CLIENT_ID` | OAuth device flow client ID | `hermes-cli` |
| `NOUS_MIN_TOKEN_TTL_SECONDS` | OAuth refresh window in seconds | `120` |

Omp fetches the Portal `/models` allowlist through its model cache. The model picker shows the context limits, supported inputs, reasoning support, and Nous pricing returned by that endpoint.

## Provider ID

OAuth and `NOUS_API_KEY` credentials both use the provider ID `nous-portal`. Omp uses its normal credential precedence when both are present.

## Development

Run the type check and unit tests:

```sh
npm run check
```

Live compatibility checks require real credentials:

```sh
npm run test:compat
```

See [`docs/testing.md`](docs/testing.md) for the required environment variables.

## Release

Releases use version tags. Bump `package.json`, merge the change into `main`, then push a matching tag:

```sh
git tag -a v0.1.1 -m "omp-nous-portal-provider 0.1.1"
git push origin v0.1.1
```

The release workflow checks that the tagged commit is on `main` and that the tag matches `package.json`. It runs the full package check before publishing to npm with trusted publishing and provenance.

## License

MIT. See [`LICENSE`](LICENSE).
