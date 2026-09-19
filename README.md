# usage

A small, read-only dashboard for AI subscription quotas behind [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

It shows, per provider pool and per account, how much allowance is left in each quota window and when it resets:

- **Codex** (ChatGPT OAuth accounts, pooled)
- **Claude** (OAuth)
- **xAI / Grok** (OAuth)
- **Z.AI** Coding Plan (API key)
- **OpenCode Go** (API key)

No mutation controls, no browser-visible credentials. The server reads CLIProxyAPI's auth files and management API, calls each provider's own usage endpoint, and exposes a normalized `/api/usage` JSON. The browser polls that once a minute.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 · Vitest · oxlint/oxfmt · pnpm · Node 24 · [Portless](https://github.com/vercel-labs/portless)

## Configuration

All settings are environment variables; defaults assume CLIProxyAPI lives at `~/subs`.

| Variable                  | Default                          | Purpose                                      |
| ------------------------- | -------------------------------- | -------------------------------------------- |
| `CPA_BASE_URL`            | `http://127.0.0.1:8317`          | CLIProxyAPI base URL                         |
| `CPA_MANAGEMENT_KEY_FILE` | `~/subs/management.key`          | Plaintext management key (read server-side)  |
| `CPA_AUTH_DIR`            | `~/subs/auth`                    | CLIProxyAPI OAuth token directory            |
| `CPA_CONFIG_FILE`         | `~/subs/config.yaml`             | Used only to read the Z.AI API key           |
| `OPENCODE_GO_ENV_FILE`    | `~/.config/subs/opencode-go.env` | File containing `OPENCODE_GO_API_KEY=…`      |
| `USAGE_CACHE_TTL_MS`      | `300000`                         | Server-side cache for upstream usage samples |

See `.env.example`.

## Development

```bash
pnpm install
pnpm dev        # served through Portless
pnpm verify     # format, typecheck, lint, tests, build
```

## Production

Build once, then run `next start` bound to loopback and put it behind whatever private HTTPS you already use (Portless, Tailscale Serve, Caddy…). An example systemd user unit is in [`deploy/usage.service`](deploy/usage.service):

```bash
pnpm build
cp deploy/usage.service ~/.config/systemd/user/
systemctl --user enable --now usage.service
```

The app listens on `127.0.0.1:$PORT` (default `8320`). Keep it off the public internet: it renders account emails and quota state.

## License

MIT
