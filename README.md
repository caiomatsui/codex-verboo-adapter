# codex-verboo

Run **Verboo Code** models inside [OpenAI Codex](https://github.com/openai/codex) on Windows.

Codex speaks the OpenAI **Responses API**, while Verboo exposes the **Chat Completions API**. This repository is a small adapter that bridges that gap: it starts a local loopback proxy that translates between the two protocols in real time, then launches Codex pointed at it.

## How it works

```
codex-verboo.cmd
      |  (Windows launcher)
      v
start-verboo.ps1
      |  1. reads VERBOO_API_KEY from .env
      |  2. picks a free loopback port
      |  3. starts verboo-responses-proxy.mjs on that port
      |  4. waits for its /health endpoint
      |  5. fetches /catalog (all models for your key) -> verboo.json
      |  6. launches Codex with:
      |        model_catalog_json = verboo.json
      |        model              = plan-adaptive default (deepseek-v4-flash when available)
      |        model_provider     = verboo
      |        base_url           = http://127.0.0.1:<port>/v1
      v
verboo-responses-proxy.mjs  (Node HTTP proxy)
      |  GET /catalog  -> builds Codex model catalog from Verboo /models
      |  POST /v1/responses  (Codex side)
      |     |- Responses input items  -> Chat Completions messages
      |     |- tools / tool_choice    -> translated
      |     '- session history        -> kept in memory (previous_response_id)
      v
Verboo Chat Completions API  (https://code.verboo.ai/router/v1)
      |  response translated back:
      |     Chat Completions choices -> Responses output items
      |     SSE stream               -> re-emitted as Responses events
      v
back to Codex
```

When Codex exits, the launcher stops the proxy automatically.

## Files

| File | Purpose |
|------|---------|
| `codex-verboo.cmd` | Entry-point launcher (Windows) |
| `start-verboo.ps1` | Orchestrates the proxy + Codex launch, loads the key, cleans up |
| `verboo-responses-proxy.mjs` | The translation proxy (Responses <-> Chat Completions, incl. streaming) |
| `.codex/config.toml` | Defines the `verboo` model provider for Codex (`CODEX_HOME`) |
| `verboo.json` | Codex model catalog, regenerated at launch from Verboo `/models` |
| `.env` | Your API key (git-ignored, you create it) |

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

To open Codex with Verboo, open a terminal **inside this folder** and run `codex-verboo` instead of `codex`:

```powershell
.\codex-verboo.cmd
```

On first launch you should see:

```
Verboo Codex adapter ready - default model: deepseek-v4-flash (use /model to switch)
```

Any combination of flags that works for `codex` also works for `codex-verboo`. For example, if you would normally run `codex --yolo`, run:

```powershell
.\codex-verboo.cmd --yolo
```

You can also pass a prompt directly, just like `codex`:

```powershell
.\codex-verboo.cmd "explain this repository"
.\codex-verboo.cmd --yolo "refactor this module"
```

The launcher reads `VERBOO_API_KEY` from `.env`, or you can set it in your shell environment instead:

```powershell
$env:VERBOO_API_KEY = "your_verboo_api_key"
.\codex-verboo.cmd
```

## Daily use

- **Default model:** the adapter picks `deepseek-v4-flash` when your plan includes it, otherwise the first model available to your key.
- **Switch models:** type `/model` inside Codex and pick any model shown. The list is built from the models your key can use, so it matches your plan (Junior, Pro, Max, Ultra, Growth...).
- **Rate/limits:** heavier models may be slower or rate-limited depending on your plan — that is Verboo-side behavior, not the adapter.
- **No leftover processes:** the proxy is started for your session and stopped when you exit Codex.

## Models

The adapter opens with a **plan-adaptive default model**:

- If your plan includes **`deepseek-v4-flash`**, it is the default.
- Otherwise, the first available model for your key is used (for example, Junior plans start with `qwen3.6-27b`).

All models available to the API key are loaded into Codex at launch, so `/model` lists exactly what your plan allows. The list is fetched live from Verboo's `/models` endpoint with your key every time you start.

If Verboo's `/models` endpoint is temporarily unavailable, the adapter falls back to the committed `verboo.json` catalog and still starts Codex with `deepseek-v4-flash`.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `VERBOO_API_KEY` | *(required)* | Verboo Code API key |
| `VERBOO_BASE_URL` | `https://code.verboo.ai/router/v1` | Upstream Verboo endpoint (used for both `/models` and `/chat/completions`) |
| `VERBOO_PROXY_PORT` | `4319` | Port the proxy listens on when not started by the launcher |

> The launcher picks a free port automatically and passes it to the proxy, so `VERBOO_PROXY_PORT` only matters if you run `verboo-responses-proxy.mjs` directly.

## Running the proxy standalone

If you want to run the proxy by itself (for debugging or a custom setup):

```powershell
$env:VERBOO_API_KEY = "your_verboo_api_key"
node verboo-responses-proxy.mjs --port 4319
```

Then point Codex at `http://127.0.0.1:4319/v1`.

## Troubleshooting

- **"VERBOO_API_KEY is not set"** — create `.env` next to `codex-verboo.cmd` with `VERBOO_API_KEY=...` or set it in the shell.
- **"provider name must not be empty" / config errors** — make sure `.codex/config.toml` is present (it is included in this repo; do not delete it).
- **`/model` shows only one model** — Verboo `/models` was unreachable and the fallback catalog was used; check your network/API key and restart.
- **Port already in use** — the launcher picks a free port automatically, so this should not happen; if you run the proxy manually, use `--port` to change it.

## Notes

- The model catalog (`verboo.json`) is regenerated on every launch from Verboo's `/models` endpoint, so it always reflects the models available to your API key. The default is `deepseek-v4-flash` when the plan includes it, otherwise the first available model.
- Only the adapter is shipped here — no personal data, secrets, or unrelated project files are included.
- This is a Windows launcher; a `.sh`/bash variant would be needed for macOS/Linux (the proxy itself is cross-platform).
