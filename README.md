# claude-sub-proxy

A lightweight proxy (~80 lines, zero dependencies) that reroutes Claude Code subagent calls to cheaper third-party models while keeping your main model on your Anthropic subscription.

**The problem**: Claude Code routers like [CCR](https://github.com/musistudio/claude-code-router) and [CCM](https://github.com/9j/claude-code-mux) require an Anthropic API key. If you're on a Claude Pro/Max subscription (OAuth), they can't authenticate your main model requests.

**The solution**: This proxy passes through your subscription auth untouched for the main model (Opus), and reroutes subagent requests (Haiku, Sonnet) to a cheaper provider using regex matching on the model name.

```
Claude Code → claude-sub-proxy → Opus requests   → api.anthropic.com (your subscription)
                                → Haiku requests  → third-party API (e.g. MiniMax)
                                → Sonnet requests → third-party API (e.g. MiniMax)
```

## Quick start

```bash
# Clone
git clone https://github.com/gaztrabisme/claude-sub-proxy.git
cd claude-sub-proxy

# Configure
mkdir -p ~/.claude-sub-proxy
cp config.example.json ~/.claude-sub-proxy/config.json
# Edit ~/.claude-sub-proxy/config.json with your API key

# Run
export MINIMAX_API_KEY="your-key-here"
node proxy.mjs

# In another terminal, launch Claude Code through the proxy
export ANTHROPIC_BASE_URL="http://127.0.0.1:13456"
claude
```

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
      "model": "MiniMax-M2.7"
    }
  ]
}
```

### Route fields

| Field | Description |
|---|---|
| `name` | Display name for logs |
| `match` | Regex pattern tested against the model name (case-insensitive) |
| `api_base` | Base URL of the target API (must be Anthropic-compatible) |
| `api_key` | API key — prefix with `$` to read from env var (e.g. `$MINIMAX_API_KEY`) |
| `model` | Model name to send to the target API |

Unmatched requests pass through to `api.anthropic.com` with original auth headers intact.

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
      "model": "MiniMax-M2.7"
    },
    {
      "name": "DeepSeek",
      "match": "sonnet",
      "api_base": "https://api.deepseek.com/v1",
      "api_key": "$DEEPSEEK_API_KEY",
      "model": "deepseek-chat"
    }
  ]
}
```

## Run as background service

```bash
# Start
MINIMAX_API_KEY="your-key" nohup node proxy.mjs > ~/.claude-sub-proxy/proxy.log 2>&1 &

# Stop
pkill -f "node.*proxy.mjs"
```

Or add to your shell profile:

```bash
# ~/.zshrc or ~/.bashrc
alias claude-proxy='MINIMAX_API_KEY="your-key" node ~/path/to/proxy.mjs &'
alias claude-routed='export ANTHROPIC_BASE_URL="http://127.0.0.1:13456" && claude'
```

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

## License

MIT
