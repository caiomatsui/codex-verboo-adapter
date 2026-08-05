import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const portArgument = process.argv.indexOf('--port');
const port = Number(portArgument >= 0 ? process.argv[portArgument + 1] : process.env.VERBOO_PROXY_PORT || 4319);
const upstreamBaseUrl = (process.env.VERBOO_BASE_URL || 'https://code.verboo.ai/router/v1').replace(/\/$/, '');
const apiKey = process.env.VERBOO_API_KEY;
const responseSessions = new Map();

const modelsCache = { data: null, fetchedAt: 0 };
const MODELS_CACHE_TTL_MS = 60_000;

// Committed fallback catalog shipped with the repo. Used when the live Verboo
// /models call fails or returns no models, so Codex still starts.
const FALLBACK_CATALOG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'verboo.json');
const DEFAULT_MODEL = 'deepseek-v4-flash';

if (!apiKey) {
  console.error('VERBOO_API_KEY is required before starting the Verboo Codex adapter.');
  process.exit(1);
}

const BASE_INSTRUCTIONS = "Before recommending or running any command that could stop, restart, or replace the environment you are running in, first determine whether you are executing inside that same environment. If you might be, do not run it yourself: warn the user explicitly that the command will end this session and let the user run it manually. Never force-kill processes by raw PID against arbitrary or unknown PID lists. To stop a dev server or free a port, stop the owning task by name; otherwise ask the user before terminating any PID.";

async function fetchModels() {
  if (modelsCache.data && Date.now() - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) {
    return modelsCache.data;
  }
  const upstream = await fetch(`${upstreamBaseUrl}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const body = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    throw new Error(body?.error?.message || `Failed to list models from Verboo (${upstream.status}).`);
  }
  const data = Array.isArray(body?.data) ? body.data : [];
  modelsCache.data = data;
  modelsCache.fetchedAt = Date.now();
  return data;
}

function reasoningLevelsFor(model) {
  const levels = model.reasoning?.effort_levels || [];
  const supported = [];
  if (levels.includes('high')) supported.push({ effort: 'high', description: 'High reasoning' });
  if (levels.includes('max')) supported.push({ effort: 'xhigh', description: 'Maximum reasoning' });
  if (levels.includes('none') || levels.length === 0) supported.push({ effort: 'low', description: 'Standard reasoning' });
  return supported;
}

function catalogEntryFor(model, index) {
  const id = model.id;
  const vision = !!model.vision;
  return {
    slug: id,
    display_name: `Verboo ${id}`,
    context_window: model.context_window || 1000000,
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: index,
    supported_reasoning_levels: reasoningLevelsFor(model),
    base_instructions: BASE_INSTRUCTIONS,
    supports_reasoning_summaries: false,
    default_reasoning_summary: 'none',
    support_verbosity: false,
    apply_patch_tool_type: 'freeform',
    input_modalities: vision ? ['text', 'image'] : ['text'],
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true,
    experimental_supported_tools: []
  };
}

function loadFallbackCatalog() {
  try {
    const raw = fs.readFileSync(FALLBACK_CATALOG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.models) || parsed.models.length === 0) return [];
    return parsed.models.map((entry) => ({
      id: entry.slug,
      context_window: entry.context_window,
      vision: Array.isArray(entry.input_modalities) && entry.input_modalities.includes('image'),
      reasoning: { effort_levels: (entry.supported_reasoning_levels || []).map((l) => l.effort) }
    }));
  } catch (error) {
    console.error(`Could not read fallback catalog at ${FALLBACK_CATALOG_PATH}:`, error.message);
  }
  return [];
}

function defaultModelFor(models) {
  if (models.some((model) => model.slug === DEFAULT_MODEL)) return DEFAULT_MODEL;
  const first = models[0]?.slug;
  return first || DEFAULT_MODEL;
}

async function buildCatalog() {
  let models;
  try {
    models = await fetchModels();
  } catch (error) {
    console.error('Verboo /models unavailable, falling back to committed catalog:', error.message);
    models = [];
  }
  if (!Array.isArray(models) || models.length === 0) {
    console.error('Verboo /models returned no models, falling back to committed catalog.');
    models = loadFallbackCatalog();
  }
  const entries = models.map(catalogEntryFor);
  // Prefer deepseek-v4-flash so it stays the default when the plan includes it.
  const sorted = [...entries].sort((a, b) => {
    if (a.slug === DEFAULT_MODEL) return -1;
    if (b.slug === DEFAULT_MODEL) return 1;
    return 0;
  });
  const defaultModel = defaultModelFor(sorted);
  return { models: sorted, default_model: defaultModel };
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.text) return part.text;
    if (part?.content) return part.content;
    return '';
  }).join('');
}

function itemToMessage(item) {
  if (typeof item === 'string') return { role: 'user', content: item };
  if (!item || typeof item !== 'object') return null;

  if (item.type === 'function_call') {
    return {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: item.call_id || item.id || `call_${crypto.randomUUID().replaceAll('-', '')}`,
        type: 'function',
        function: { name: item.name, arguments: item.arguments || '{}' }
      }]
    };
  }

  if (item.type === 'function_call_output') {
    return {
      role: 'tool',
      tool_call_id: item.call_id,
      content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
    };
  }

  // Verboo's Chat Completions endpoint accepts the classic system/user/assistant
  // roles. Codex emits developer instructions in Responses input, which carry
  // the same precedence for this compatibility adapter.
  const role = item.role === 'developer' ? 'system' : (item.role || 'user');
  const content = textFromContent(item.content ?? item.input ?? item.text);
  return content || role !== 'assistant' ? { role, content } : null;
}

function outputToHistoryMessages(output) {
  const functionCalls = output.filter((item) => item.type === 'function_call');
  if (functionCalls.length) {
    // Chat Completions requires every tool result in a turn to follow the one
    // assistant message that declared all of that turn's tool calls.
    return [{
      role: 'assistant',
      content: '',
      tool_calls: functionCalls.map((item) => ({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments || '{}' }
      }))
    }];
  }
  return output.map(itemToMessage).filter(Boolean);
}

function requestMessages(payload) {
  const previous = payload.previous_response_id ? responseSessions.get(payload.previous_response_id) : null;
  const messages = previous ? [...previous] : [];
  if (!previous && payload.instructions) messages.push({ role: 'system', content: payload.instructions });

  const input = Array.isArray(payload.input) ? payload.input : [payload.input];
  const pendingToolCalls = [];
  const flushToolCalls = () => {
    if (!pendingToolCalls.length) return;
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: pendingToolCalls.splice(0).map((item) => ({
        id: item.call_id || item.id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments || '{}' }
      }))
    });
  };
  for (const item of input) {
    if (item?.type === 'function_call') {
      pendingToolCalls.push(item);
      continue;
    }
    flushToolCalls();
    const message = itemToMessage(item);
    if (message) messages.push(message);
  }
  flushToolCalls();
  return messages;
}

function requestTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const translated = tools
    .filter((tool) => tool?.type === 'function')
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters || { type: 'object', properties: {} },
        ...(tool.strict === undefined ? {} : { strict: tool.strict })
      }
    }));
  return translated.length ? translated : undefined;
}

function requestToolChoice(choice) {
  if (!choice || typeof choice === 'string') return choice;
  if (choice.type === 'function') {
    return { type: 'function', function: { name: choice.name || choice.function?.name } };
  }
  return undefined;
}

function responseItemFromChoice(choice) {
  const message = choice.message || {};
  const toolCalls = message.tool_calls || [];
  if (toolCalls.length) {
    return toolCalls.map((toolCall) => ({
      type: 'function_call',
      id: `fc_${crypto.randomUUID().replaceAll('-', '')}`,
      call_id: toolCall.id,
      name: toolCall.function?.name,
      arguments: toolCall.function?.arguments || '{}',
      status: 'completed'
    }));
  }

  const text = textFromContent(message.content);
  return [{
    type: 'message',
    id: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
    status: 'completed',
    role: 'assistant',
    content: text ? [{ type: 'output_text', text, annotations: [] }] : []
  }];
}

function responsesPayload(upstream, model) {
  const choice = upstream.choices?.[0] || { message: { content: '' } };
  const output = responseItemFromChoice(choice);
  const text = output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .map((part) => part.text || '')
    .join('');
  return {
    id: `resp_${crypto.randomUUID().replaceAll('-', '')}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: upstream.model || model,
    output,
    output_text: text,
    usage: {
      input_tokens: upstream.usage?.prompt_tokens || 0,
      output_tokens: upstream.usage?.completion_tokens || 0,
      total_tokens: upstream.usage?.total_tokens || 0
    }
  };
}

function sseEvent(response, type, data) {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

function streamResponse(response, completed) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  const inProgress = { ...completed, status: 'in_progress', output: [] };
  sseEvent(response, 'response.created', { response: inProgress });
  sseEvent(response, 'response.in_progress', { response: inProgress });

  for (let index = 0; index < completed.output.length; index += 1) {
    const item = completed.output[index];
    sseEvent(response, 'response.output_item.added', { output_index: index, item });
    if (item.type === 'function_call') {
      sseEvent(response, 'response.function_call_arguments.delta', {
        output_index: index, item_id: item.id, delta: item.arguments
      });
      sseEvent(response, 'response.function_call_arguments.done', {
        output_index: index, item_id: item.id, arguments: item.arguments
      });
    } else {
      const textPart = item.content?.[0];
      if (textPart?.text) {
        sseEvent(response, 'response.content_part.added', { output_index: index, content_index: 0, part: textPart });
        sseEvent(response, 'response.output_text.delta', {
          output_index: index, content_index: 0, item_id: item.id, delta: textPart.text
        });
        sseEvent(response, 'response.output_text.done', {
          output_index: index, content_index: 0, item_id: item.id, text: textPart.text
        });
        sseEvent(response, 'response.content_part.done', { output_index: index, content_index: 0, part: textPart });
      }
    }
    sseEvent(response, 'response.output_item.done', { output_index: index, item });
  }
  sseEvent(response, 'response.completed', { response: completed });
  response.end();
}

async function handleResponses(request, response) {
  const payload = await readJson(request);
  const messages = requestMessages(payload);
  let resolvedModel = payload.model;
  if (!resolvedModel) {
    try { resolvedModel = (await buildCatalog()).default_model; }
    catch { resolvedModel = DEFAULT_MODEL; }
  }
  const upstreamPayload = {
    model: resolvedModel,
    messages,
    stream: false
  };
  const tools = requestTools(payload.tools);
  if (tools) upstreamPayload.tools = tools;
  const toolChoice = requestToolChoice(payload.tool_choice);
  if (toolChoice) upstreamPayload.tool_choice = toolChoice;

  const upstream = await fetch(`${upstreamBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(upstreamPayload)
  });
  const upstreamText = await upstream.text();
  let upstreamBody;
  try { upstreamBody = upstreamText ? JSON.parse(upstreamText) : {}; } catch { upstreamBody = {}; }
  if (!upstream.ok) {
    json(response, upstream.status, {
      error: {
        message: upstreamBody?.error?.message || upstreamBody?.message || upstreamText.slice(0, 1000) || `Verboo Chat Completions request failed (${upstream.status} ${upstream.statusText}).`,
        type: upstreamBody?.error?.type || 'upstream_error'
      }
    });
    return;
  }

  const completed = responsesPayload(upstreamBody, upstreamPayload.model);
  const assistantMessages = outputToHistoryMessages(completed.output);
  responseSessions.set(completed.id, [...messages, ...assistantMessages]);
  if (responseSessions.size > 100) responseSessions.delete(responseSessions.keys().next().value);

  if (payload.stream) streamResponse(response, completed);
  else json(response, 200, completed);
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') return json(response, 200, { status: 'ok' });
    if (request.method === 'GET' && request.url === '/catalog') {
      try { return json(response, 200, await buildCatalog()); }
      catch (error) { return json(response, 502, { error: { message: error instanceof Error ? error.message : 'Failed to build catalog.' } }); }
    }
    if (request.method === 'GET' && request.url === '/catalog/default-model') {
      try { return json(response, 200, { default_model: (await buildCatalog()).default_model }); }
      catch (error) { return json(response, 502, { error: { message: error instanceof Error ? error.message : 'Failed to resolve default model.' } }); }
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      try { return json(response, 200, { object: 'list', data: await fetchModels() }); }
      catch (error) { return json(response, 502, { error: { message: error instanceof Error ? error.message : 'Failed to list models.' } }); }
    }
    if (request.method === 'POST' && request.url === '/v1/responses') return await handleResponses(request, response);
    json(response, 404, { error: { message: 'Not found.' } });
  } catch (error) {
    console.error(error);
    json(response, 500, { error: { message: error instanceof Error ? error.message : 'Unexpected adapter error.' } });
  }
});

server.listen(port, '127.0.0.1', () => console.error(`Verboo Codex adapter listening on http://127.0.0.1:${port}/v1`));

function shutdown() { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
