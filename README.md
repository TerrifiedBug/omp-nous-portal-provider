# omp-nous-portal-provider

A Nous Research Portal provider for [oh-my-pi](https://github.com/can1357/oh-my-pi). It supports Portal OAuth subscriptions and direct inference API keys.

Requires OMP 18.4.2 or newer in the 18.x series. The optional broker command also requires Bun 1.3.14 or newer.

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

## Broker-backed OAuth

When clients use `OMP_AUTH_BROKER_URL`, the broker owns refresh-token rotation. A stock `omp auth-broker serve` process does not load client-side provider plugins, so a successful Nous login can otherwise fail at the next access-token expiry.

On the **broker host**, install this package and replace the existing broker startup command with the plugin's entry point:

```sh
"$HOME/.omp/plugins/node_modules/.bin/omp-nous-broker" --bind=127.0.0.1:8765
```

Stop the old broker before starting its replacement. Keep the same `HOME`, OMP profile, `PI_CODING_AGENT_DIR`, and bind address as the old process. The command uses OMP's existing SQLite credential vault and `auth-broker.token`; it never creates a separate token store or connects back to `OMP_AUTH_BROKER_URL`. If the bearer file has not been initialized, use OMP's `auth-broker token` command first; its printed bearer is a secret.

The plugin supplies only the Nous refresh callback. OMP's stock SDK still owns the HTTP server, scheduled refresh, persistence, single-flight coordination, and redacted client snapshots; its built-in-provider and managed-MCP refresh handlers remain in use. No unrelated desktop extensions or model discovery are loaded by this entry point. Existing clients keep their broker URL and bearer token.

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
git tag -a v0.1.2 -m "omp-nous-portal-provider 0.1.2"
git push origin v0.1.2
```

The release workflow checks that the tagged commit is on `main` and that the tag matches `package.json`. It runs the full package check before publishing to npm with trusted publishing and provenance.

## License

MIT. See [`LICENSE`](LICENSE).
