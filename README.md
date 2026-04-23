# pi-agent-fireworks-ai

Custom [Fireworks AI](https://fireworks.ai/) provider for the [pi coding agent](https://github.com/badlogic/pi-mono).

## Features

- **Native OpenAI-compatible API** — uses Fireworks' `/v1/chat/completions` endpoint
- **Auto-discovery** — fetches all available serverless models from Fireworks on startup
- **Live pricing** — pulls accurate per-model costs and context windows via `firectl`
- **Multiple auth methods** — supports `FIREWORKS_API_KEY` env var or `~/.pi/agent/auth.json`
- **Rate-limit observability** — logs `x-ratelimit-*` headers so you know when you're about to hit the wall
- **OpenAI compat flags** — disables `reasoning_effort`, `store`, and `developer` role that Fireworks doesn't support

## Supported Models

| Model | Reasoning | Vision | Context |
|---|---|---|---|
| Kimi K2.6 | ✅ | ✅ | 262K |
| Llama 3.1 405B Instruct | ❌ | ❌ | 131K |
| DeepSeek R1 | ✅ | ❌ | 164K |
| MiniMax M2.7 | ❌ | ❌ | 197K |
| GLM 5.1 | ❌ | ❌ | 203K |
| Qwen3.6 Plus | ❌ | ✅ | 128K |

Plus any other `accounts/fireworks/models/*` discovered from the API.

## Installation

### Option 1: Symlink (for development / personal use)

```bash
git clone https://github.com/lunoho/pi-agent-fireworks-ai.git ~/src/pi-agent/fireworks-ai
ln -s ~/src/pi-agent/fireworks-ai/src/fireworks.ts ~/.pi/agent/extensions/fireworks.ts
```

Then in pi: `/reload`

### Option 2: `pi install` (for end users)

```bash
pi install git:github.com/lunoho/pi-agent-fireworks-ai
```

## API Key Setup

### Environment variable

```bash
export FIREWORKS_API_KEY="fw-..."
```

### `~/.pi/agent/auth.json`

```json
{
  "fireworks": {
    "type": "api_key",
    "key": "fw-..."
  }
}
```

## Usage

```bash
# Interactive
pi -m fireworks/accounts/fireworks/models/kimi-k2p6

# One-shot
pi -m fireworks/accounts/fireworks/models/deepseek-r1 "refactor this function"
```

## Rate Limits

Fireworks' free/low tiers are aggressively throttled (often 10 RPM). The extension logs `x-ratelimit-*` headers to the console so you can see exactly which limit you're hitting:

```
[fireworks] x-ratelimit-remaining-requests: 3
[fireworks] 429 RATE LIMITED
```

## Requirements

- [pi coding agent](https://github.com/badlogic/pi-mono) ≥ 0.68.x
- [firectl](https://docs.fireworks.ai/tools-sdks/firectl) (optional — enriches model metadata if installed)
- Fireworks API key

## License

MIT
