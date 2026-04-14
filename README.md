# claude-sub-proxy

A lightweight proxy with a built-in CLI that reroutes Claude Code subagent calls to cheaper third-party models while keeping your main model on your Anthropic subscription.

**The problem**: Claude Code routers like [CCR](https://github.com/musistudio/claude-code-router) and [CCM](https://github.com/9j/claude-code-mux) require an Anthropic API key. If you're on a Claude Pro/Max subscription (OAuth), they can't authenticate your main model requests.

**The solution**: This proxy passes through your subscription auth untouched for the main model (Opus), and reroutes subagent requests (Haiku, Sonnet) to a cheaper provider using regex matching on the model name.

```
Claude Code → claude-sub-proxy → Opus requests   → api.anthropic.com (your subscription)
                                → Haiku requests  → third-party API (e.g. MiniMax)
                                → Sonnet requests → third-party API (e.g. MiniMax)
```

## Quick start

```bash
# Install the CLI from GitHub
curl -fsSL https://raw.githubusercontent.com/hunguyen1702/claude-sub-proxy/master/install.sh | bash

# Configure routing
claude-sub-proxy configure init
claude-sub-proxy configure add

# Point Claude Code at the proxy (interactive)
claude-sub-proxy install-claude

# Install and start the background service
claude-sub-proxy install-service
claude-sub-proxy service start

# Launch Claude Code
claude
```

Prefer a local checkout instead of `curl | bash`:

```bash
git clone https://github.com/hunguyen1702/claude-sub-proxy.git
cd claude-sub-proxy
./install.sh
```

Uninstall:

```bash
./uninstall.sh
```

## CLI commands

```bash
claude-sub-proxy start
claude-sub-proxy install-claude
claude-sub-proxy install-service
claude-sub-proxy service start
claude-sub-proxy service restart
claude-sub-proxy service stop
claude-sub-proxy configure init
claude-sub-proxy configure claude
claude-sub-proxy configure show
claude-sub-proxy configure add
claude-sub-proxy configure remove <name>
```

## Installer

The installer only makes the `claude-sub-proxy` command available. It does not create config, modify Claude settings, or install the background service automatically.

```bash
curl -fsSL https://raw.githubusercontent.com/hunguyen1702/claude-sub-proxy/master/install.sh | bash
```

By default the installer downloads the `latest` Git tag. Override it with `CLAUDE_SUB_PROXY_INSTALL_REF` to install a different tag:

```bash
CLAUDE_SUB_PROXY_INSTALL_REF=v1.0.0 \
curl -fsSL https://raw.githubusercontent.com/hunguyen1702/claude-sub-proxy/master/install.sh | bash
```

To fully remove the global package, service, config, and local proxy Claude settings, run:

```bash
curl -fsSL https://raw.githubusercontent.com/hunguyen1702/claude-sub-proxy/master/uninstall.sh | bash
```

Requirements:

- `bash`
- `curl`
- `tar`
- Node.js 18+
- `npm`

If npm installs the package into a directory that is not on your `PATH`, the installer prints the exact export line to add to your shell profile.

## Configuration

Config lives at `~/.claude-sub-proxy/config.json` (override with `CSP_CONFIG` env var).

```json
{
  "port": 13456,
  "routes": [
    {
      "name": "MiniMax",
      "match": "haiku|sonnet",
      "api_base": "https://api.minimax.io/anthropic",
      "api_key": "$MINIMAX_API_KEY",
      "model": "MiniMax-M2.7",
      "auth_scheme": "x-api-key"
    }
  ]
}
```

### Route fields

| Field | Description |
|---|---|
| `name` | Display name for logs and unique identifier for `configure remove` |
| `match` | Regex pattern tested against the model name (case-insensitive) |
| `api_base` | Base URL of the target API (must be Anthropic-compatible) |
| `api_key` | API key — prefix with `$` to read from env var (e.g. `$MINIMAX_API_KEY`) |
| `model` | Model name to send to the target API |
| `auth_scheme` | Auth header style for routed requests: `x-api-key` (default) or `bearer` |

Unmatched requests pass through to `api.anthropic.com` with original auth headers intact.

`configure show` redacts API keys in terminal output. `configure remove <name>` deletes a route by its unique name.

### Multiple routes

You can route different models to different providers:

```json
{
  "port": 13456,
  "routes": [
    {
      "name": "MiniMax",
      "match": "haiku",
      "api_base": "https://api.minimax.io/anthropic",
      "api_key": "$MINIMAX_API_KEY",
      "model": "MiniMax-M2.7",
      "auth_scheme": "x-api-key"
    },
    {
      "name": "DeepSeek",
      "match": "sonnet",
      "api_base": "https://api.deepseek.com/v1",
      "api_key": "$DEEPSEEK_API_KEY",
      "model": "deepseek-chat",
      "auth_scheme": "bearer"
    }
  ]
}
```

## Run as background service

```bash
claude-sub-proxy install-service
claude-sub-proxy service start
claude-sub-proxy service restart
claude-sub-proxy service stop
```

Supported service managers:

- macOS: `launchd` LaunchAgent in `~/Library/LaunchAgents`
- Linux: `systemd --user` unit in `~/.config/systemd/user`

Service mode should use raw API keys in `~/.claude-sub-proxy/config.json`. Shell environment variables are not a reliable source for background services.
Service logs are system-managed:

- macOS: sent to the system log via `logger`
- Linux: sent to `journald` and viewed with `journalctl`

## Configure Claude endpoint

Use the interactive installer to set `ANTHROPIC_BASE_URL` in Claude Code `settings.json`:

```bash
claude-sub-proxy install-claude
```

The command lets you choose where to write:

- `~/.claude/settings.json`
- `.claude/settings.json`
- `.claude/settings.local.json`

If `env.ANTHROPIC_BASE_URL` already exists with a different value, the installer shows a warning and asks before overwriting.

## How it works

1. Claude Code sends all API requests to the proxy (`ANTHROPIC_BASE_URL`)
2. Proxy parses the `model` field from the request body
3. If the model matches a route regex → rewrite model name, swap auth, forward to third-party API
4. Otherwise → forward to `api.anthropic.com` with original headers (subscription OAuth passes through)

No dependencies. No build step. Just Node.js 18+.

## Supported providers

Any provider with an Anthropic-compatible Messages API endpoint works. Tested with:

- [MiniMax](https://platform.minimax.io) — `MiniMax-M2.7` via `https://api.minimax.io/anthropic`

PRs welcome for other providers.

## Environment variables

| Variable | Description |
|---|---|
| `CSP_CONFIG` | Path to config file (default: `~/.claude-sub-proxy/config.json`) |
| `CSP_PORT` | Override port (default: from config or `13456`) |

## Troubleshooting

### Linux

- Check service status with `systemctl --user status com.claude-sub-proxy`.
- Stream logs with `journalctl --user-unit com.claude-sub-proxy -f`.
- Show recent logs with `journalctl --user-unit com.claude-sub-proxy --since "1 hour ago"`.

### MacOS

- Check service status with `launchctl print gui/$(id -u)/com.claude-sub-proxy`.
- Stream logs with `log stream --style syslog --predicate 'eventMessage CONTAINS "claude-sub-proxy"'`.
- Show recent logs with `log show --last 1h --style syslog --predicate 'eventMessage CONTAINS "claude-sub-proxy"'`.

## License

MIT
