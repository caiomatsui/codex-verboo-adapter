# codex-verboo

Run **Verboo Code** models inside [OpenAI Codex](https://github.com/openai/codex) on Windows.

Codex speaks the OpenAI **Responses API**, while Verboo exposes the **Chat Completions API**. This repository is a small adapter that bridges that gap: it starts a local loopback proxy that translates between the two protocols in real time, then launches Codex pointed at it.

## How it works

```
codex-verboo.cmd
      │  (Windows launcher)
      ▼
start-verboo.ps1
      │  1. reads VERBOO_API_KEY from .env
      │  2. picks a free loopback port
      │  3. starts verboo-responses-proxy.mjs on that port
      │  4. waits for its /health endpoint
      │  5. launches Codex with:
      │        model_catalog_json = verboo.json
      │        model              = deepseek-v4-flash
      │        model_provider     = verboo
      │        base_url           = http://127.0.0.1:<port>/v1
      ▼
verboo-responses-proxy.mjs  (Node HTTP proxy)
      │  POST /v1/responses  (Codex side)
      │     ├─ Responses input items  → Chat Completions messages
      │     ├─ tools / tool_choice    → translated
      │     └─ session history        → kept in memory (previous_response_id)
      ▼
Verboo Chat Completions API  (https://code.verboo.ai/router/v1)
      │  response translated back:
      │     Chat Completions choices → Responses output items
      │     SSE stream               → re-emitted as Responses events
      ▼
back to Codex
```

When Codex exits, the launcher stops the proxy automatically.

## Files

| File | Purpose |
|------|---------|
| `codex-verboo.cmd` | Entry-point launcher (Windows) |
| `start-verboo.ps1` | Orchestrates the proxy + Codex launch, loads the key, cleans up |
| `verboo-responses-proxy.mjs` | The translation proxy (Responses ↔ Chat Completions, incl. streaming) |
| `verboo.json` | Codex model catalog for the Verboo model |

## Requirements

- [Node.js](https://nodejs.org/) 18+ (for the proxy)
- [Codex CLI](https://github.com/openai/codex) installed and on your `PATH`
- Windows (the launcher is a `.cmd` + PowerShell script)
- A Verboo Code API key from [https://code.verboo.ai/](https://code.verboo.ai/)

## Installation

Clone or copy this repository into a folder, then create a `.env` file next to `codex-verboo.cmd`:

```env
VERBOO_API_KEY=your_verboo_api_key
```

`.env` is ignored by Git — never commit real keys.

## Usage

From the repository folder, run:

```powershell
.\codex-verboo.cmd
```

You can pass any normal Codex arguments through, for example:

```powershell
.\codex-verboo.cmd "explain this repository"
```

The launcher reads `VERBOO_API_KEY` from `.env`, or you can set it in your shell environment instead:

```powershell
$env:VERBOO_API_KEY = "your_verboo_api_key"
.\codex-verboo.cmd
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `VERBOO_API_KEY` | *(required)* | Verboo Code API key |
| `VERBOO_BASE_URL` | `https://code.verboo.ai/router/v1` | Upstream Verboo endpoint |
| `VERBOO_PROXY_PORT` | `4319` | Port the proxy listens on when not started by the launcher |

> The launcher picks a free port automatically and passes it to the proxy, so `VERBOO_PROXY_PORT` only matters if you run `verboo-responses-proxy.mjs` directly.

## Running the proxy standalone

If you want to run the proxy by itself (for debugging or a custom setup):

```powershell
$env:VERBOO_API_KEY = "your_verboo_api_key"
node verboo-responses-proxy.mjs --port 4319
```

Then point Codex at `http://127.0.0.1:4319/v1`.

## Notes

- The model catalog (`verboo.json`) currently defines the `deepseek-v4-flash` model with a 1M-token context window and tool-call support.
- Only the adapter is shipped here — no personal data, secrets, or unrelated project files are included.
- This is a Windows launcher; a `.sh`/bash variant would be needed for macOS/Linux (the proxy itself is cross-platform).
