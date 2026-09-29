# usage

A small, read-only dashboard for AI subscription quotas behind [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

It shows, per provider pool and per account, how much allowance is left in each quota window and when it resets:

- **Codex** (ChatGPT OAuth accounts, pooled)
- **Claude** (OAuth)
- **Z.AI** Coding Plan (API key)
- **OpenCode Go** (API key)

No mutation controls, no browser-visible credentials. The server reads CLIProxyAPI's auth files and management API, calls each provider's own usage endpoint, and exposes a normalized `/api/usage` JSON. The browser polls that once a minute.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 · Vitest · oxlint/oxfmt · pnpm · Node 24 · [Portless](https://github.com/vercel-labs/portless)

## Configuration

All settings are environment variables; defaults assume CLIProxyAPI lives at `~/subs`.

| Variable                  | Default                                                               | Purpose                                                         |
| ------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------- |
| `CPA_BASE_URL`            | `http://127.0.0.1:8317`                                               | CLIProxyAPI base URL                                            |
| `CPA_MANAGEMENT_KEY_FILE` | `~/subs/management.key`                                               | Plaintext management key (read server-side)                     |
| `CPA_AUTH_DIR`            | `~/subs/auth`                                                         | CLIProxyAPI OAuth token directory                               |
| `CPA_CONFIG_FILE`         | `~/subs/config.yaml`                                                  | Used only to read the Z.AI API key                              |
| `OPENCODE_GO_ENV_FILE`    | `~/.config/subs/opencode-go.env`                                      | File containing `OPENCODE_GO_API_KEY=…`                         |
| `USAGE_CACHE_TTL_MS`      | `300000`                                                              | Server-side snapshot cache (at most 60 s if any account failed) |
| `USAGE_STATE_FILE`        | `$STATE_DIRECTORY/state.json`, else `~/.local/state/usage/state.json` | Persisted per-account samples (see below)                       |
| `CLAUDE_CLI_VERSION`      | `2.1.283`                                                             | Claude Code version presented when reading Claude limit resets  |

See `.env.example`.

### Caching and persisted state

The page and `/api/usage` share one in-process cache: each account keeps its last reading and is re-queried only after its own interval (Claude 10 min, others 5 min) or, after an error, its backoff (honouring `Retry-After`, up to an hour). A failed refresh keeps showing the last good reading marked stale.

Per-account samples are also written to `USAGE_STATE_FILE` (mode `0600`, atomically, only after an upstream call), so a restart keeps last-good data and does not re-query a provider that is still in backoff. The file holds account emails and quota state (windows, reset credits, status); it never contains credentials. A missing, corrupt or outdated file is ignored and rebuilt.

## Development

```bash
pnpm install
pnpm dev        # served through Portless
pnpm verify     # format, typecheck, lint, tests, build
```

## Limit resets

Account cards show banked "reset" offers (count and soonest expiry) for Codex and Claude. Neither is spent from here.

Claude resets come from an undocumented part of the same usage endpoint Claude Code uses: `GET https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1`, whose `cedar_ember` block lists grants with `resets_left`, `ends_at`, and `paused`. Anthropic only reports grants to a current Claude Code CLI client, so this request sends `User-Agent: claude-cli/$CLAUDE_CLI_VERSION (external, cli)` and `x-app: cli`. When Anthropic stops recognising that version it answers `eligible: false` (reason `surface`) or `eligible: null`; the card then shows no reset line and the server logs `Claude reset status unavailable … raise CLAUDE_CLI_VERSION`. Set it to the current `@anthropic-ai/claude-code` release and restart.

## Production

Build once, then run `next start` bound to loopback and put it behind whatever private HTTPS you already use (Portless, Tailscale Serve, Caddy…). An example systemd user unit is in [`deploy/usage.service`](deploy/usage.service); it expects this checkout at `~/usage` and CLIProxyAPI at `~/subs`, and orders itself after a `subs.service` unit. Do not give that proxy unit `After=default.target`: `default.target` wants both units, so the edge forms an ordering cycle and systemd drops `usage.service` at boot.

```bash
pnpm build
cp deploy/usage.service ~/.config/systemd/user/
systemctl --user enable --now usage.service
```

The app listens on `127.0.0.1:$PORT` (default `8320`). Keep it off the public internet: it renders account emails and quota state.

## License

MIT
