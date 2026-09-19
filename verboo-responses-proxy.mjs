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
let responseSessionBytes = 0;

// Stored turns now carry images, so the history store is capped by total bytes
// as well as by count; the oldest turns are dropped first.
const MAX_RESPONSE_SESSIONS = 100;
const MAX_RESPONSE_SESSION_BYTES = 64 * 1024 * 1024;

function rememberSession(id, messages) {
  const bytes = JSON.stringify(messages).length;
  responseSessions.set(id, { messages, bytes });
  responseSessionBytes += bytes;
  while (responseSessions.size > MAX_RESPONSE_SESSIONS
    || (responseSessionBytes > MAX_RESPONSE_SESSION_BYTES && responseSessions.size > 1)) {
    const oldest = responseSessions.keys().next().value;
    responseSessionBytes -= responseSessions.get(oldest).bytes;
    responseSessions.delete(oldest);
  }
}

const modelsCache = { data: null, fetchedAt: 0 };
const MODELS_CACHE_TTL_MS = 60_000;

// Committed fallback catalog shipped with the repo. Used when the live Verboo
// /models call fails or returns no models, so Codex still starts.
const FALLBACK_CATALOG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'verboo.json');
const DEFAULT_MODEL = 'deepseek-v4-flash-0731';

if (!apiKey) {
  console.error('VERBOO_API_KEY is required before starting the Verboo Codex adapter.');
  process.exit(1);
}

const BASE_INSTRUCTIONS = "Before recommending or running any command that could stop, restart, or replace the environment you are running in, first determine whether you are executing inside that same environment. If you might be, do not run it yourself: warn the user explicitly that the command will end this session and let the user run it manually. Never force-kill processes by raw PID against arbitrary or unknown PID lists. To stop a dev server or free a port, stop the owning task by name; otherwise ask the user before terminating any PID.";

// ---- Images ---------------------------------------------------------------
//
// Codex returns image results (view_image) as Responses "input_image" parts
// inside a function_call_output. Forwarding those parts as they arrive caused
// two problems:
//
//   1. Verboo's router ignores images that sit inside a tool message, so the
//      model never actually saw the frame.
//   2. Stringifying the parts into the tool text (the previous behaviour) hid
//      the image from the model *and* broke the request: inline data URLs in
//      text are rejected once a request carries roughly 1.5 MB of base64,
//      answering HTTP 400 {"code":"unclassified","error":"invalid request"}.
//
// Images are therefore forwarded as real image content parts in a user message
// that follows the tool results, and oversized images are downscaled first.

const MAX_IMAGE_BYTES_PER_IMAGE = 400 * 1024;
const MAX_IMAGE_BYTES_PER_REQUEST = 8 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1568;
const IMAGE_JPEG_QUALITY = 82;

// sharp is optional: when it is missing the adapter still runs, it just
// forwards images at their original size.
let sharpPromise;
function loadSharp() {
  if (!sharpPromise) {
    sharpPromise = import('sharp').then((module) => module.default).catch(() => null);
  }
  return sharpPromise;
}

function parseImageDataUrl(url) {
  if (typeof url !== 'string') return null;
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url);
  return match ? { mediaType: match[1], base64: match[2] } : null;
}

function imageUrlOf(part) {
  if (!part) return null;
  if (typeof part.image_url === 'string') return part.image_url;
  if (part.image_url && typeof part.image_url.url === 'string') return part.image_url.url;
  return null;
}

function imageDetailOf(part) {
  if (!part) return 'high';
  if (part.image_url && typeof part.image_url === 'object' && part.image_url.detail) return part.image_url.detail;
  return part.detail || 'high';
}

function isImagePart(part) {
  return !!part && (part.type === 'input_image' || part.type === 'image_url') && !!imageUrlOf(part);
}

// Codex sends images either as Responses "input_image" parts or as
// chat-completions "image_url" parts; both are normalised to one shape.
function imagePartsFromContent(content) {
  if (!Array.isArray(content)) return [];
  return content.filter(isImagePart).map((part) => ({ url: imageUrlOf(part), detail: imageDetailOf(part) }));
}

function imageContentPart(image) {
  return { type: 'image_url', image_url: { url: image.url, detail: image.detail } };
}

// Downscales one data URL when it is larger than the per-image budget. Returns
// the original URL when sharp is unavailable or the result would not be smaller.
async function shrinkImageUrl(url) {
  const parsed = parseImageDataUrl(url);
  if (!parsed || parsed.base64.length <= MAX_IMAGE_BYTES_PER_IMAGE) return url;
  const sharp = await loadSharp();
  if (!sharp) return url;
  try {
    const source = Buffer.from(parsed.base64, 'base64');
    const resized = await sharp(source)
      .resize({ width: MAX_IMAGE_DIMENSION, height: MAX_IMAGE_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: IMAGE_JPEG_QUALITY })
      .toBuffer();
    if (resized.length >= source.length) return url;
    return `data:image/jpeg;base64,${resized.toString('base64')}`;
  } catch (error) {
    console.error('Verboo adapter: could not downscale an image:', error instanceof Error ? error.message : error);
    return url;
  }
}

async function shrinkImagesInMessages(messages) {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const url = imageUrlOf(part);
      if (!url) continue;
      const shrunk = await shrinkImageUrl(url);
      if (shrunk === url) continue;
      if (typeof part.image_url === 'string') part.image_url = shrunk;
      else part.image_url.url = shrunk;
    }
  }
}

function messagesContainImages(messages) {
  return messages.some((message) => Array.isArray(message.content) && message.content.some(isImagePart));
}

// Last-resort degradation: swap every image for a text note so a rejected
// request can be retried instead of failing the whole turn.
function stripImagesFromMessages(messages) {
  let removed = 0;
  const stripped = messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const content = message.content.map((part) => {
      if (!isImagePart(part)) return part;
      removed += 1;
      return { type: 'text', text: '[image omitted: this request could not carry images]' };
    });
    return { ...message, content };
  });
  return { messages: stripped, removed };
}

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

// ---- Reasoning effort vocabulary -----------------------------------------
//
// Codex understands none, minimal, low, medium, high, xhigh, max, ultra and
// persistent. Verboo's /models announces its own per-model set, and the router
// rejects levels outside that set with HTTP 400 "invalid request"
// (deepseek-v4.1-flash rejects medium/minimal/ultra/persistent, qwen3.8-27b
// rejects high/max).
//
// Announced sets seen in the wild:
//   deepseek-v4-flash-0731 -> low, medium, high, xhigh, max
//   deepseek-v4-flash      -> high, max
//   glm-5.3-flash          -> low, high, max
//   qwen3.8-27b            -> none, low, medium, xhigh
//   deepseek-v4.1-flash    -> "1", "25", "50", "100"  (numeric budget scale)
//   mimo-v2.5              -> (nothing announced)
//
// Earlier adapter versions collapsed Verboo's "max" into Codex's "xhigh", which
// hid the real Maximum level: Codex only reveals Max in its "More reasoning..."
// -> "Advanced Reasoning" submenu when the catalog actually advertises it.
// "max" is now published as "max".
const EFFORT_RANK = {
  none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6, ultra: 7
};

const EFFORT_DESCRIPTIONS = {
  none: 'No reasoning',
  minimal: 'Minimal reasoning',
  low: 'Standard reasoning',
  medium: 'Balanced reasoning',
  high: 'High reasoning',
  xhigh: 'Extra high reasoning',
  max: 'Maximum reasoning'
};

// Levels offered when a model announces nothing usable.
const FALLBACK_EFFORTS = ['low', 'high', 'xhigh', 'max'];

// deepseek-v4.1-flash announces a numeric budget scale that the router does not
// accept on the wire ("reasoning_effort": "100" answers HTTP 400). These are
// the words that model does accept.
const NUMERIC_SCALE_EFFORTS = ['none', 'low', 'high', 'xhigh', 'max'];

// Level a new conversation starts at. Override per launch with
// VERBOO_REASONING_EFFORT (the launcher exposes it as --effort).
const DEFAULT_REASONING_EFFORT = String(process.env.VERBOO_REASONING_EFFORT || 'xhigh').trim().toLowerCase();

function isNumericEffort(value) {
  return /^\d+$/.test(String(value).trim());
}

function effortOption(effort) {
  return { effort, description: EFFORT_DESCRIPTIONS[effort] || 'Reasoning' };
}

// Codex sends "ultra" for its maximum-plus-delegation level. Verboo has no
// equivalent and rejects the word, so it is sent as "max".
function normalizeEffort(effort) {
  if (typeof effort !== 'string') return undefined;
  const value = effort.trim().toLowerCase();
  if (!value) return undefined;
  return value === 'ultra' ? 'max' : value;
}

function announcedEfforts(model) {
  const levels = model?.reasoning?.effort_levels;
  if (!Array.isArray(levels)) return [];
  return levels.map((level) => String(level).trim()).filter(Boolean);
}

// Levels advertised to Codex for a model, in ascending order.
function reasoningLevelsFor(model) {
  const announced = announcedEfforts(model);
  if (announced.length > 0 && announced.every(isNumericEffort)) {
    return NUMERIC_SCALE_EFFORTS.map(effortOption);
  }
  const known = announced.filter((level) => level in EFFORT_RANK);
  if (known.length === 0) return FALLBACK_EFFORTS.map(effortOption);
  return [...new Set(known)]
    .sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b])
    .map(effortOption);
}

// Levels we believe Verboo accepts for a model. null means "unknown, pass the
// request through unchanged": models that announce nothing ignore the field, so
// filtering would only remove capability.
function acceptedEffortsFor(model) {
  if (!model) return null;
  const announced = announcedEfforts(model);
  if (announced.length === 0) return null;
  if (announced.every(isNumericEffort)) return new Set(NUMERIC_SCALE_EFFORTS);
  return new Set(announced.filter((level) => level in EFFORT_RANK));
}

// Default level for a model: the configured default when the model offers it,
// otherwise the closest level below it, otherwise the model's lowest level.
function defaultReasoningLevelFor(levels) {
  const available = levels.map((level) => level.effort);
  if (available.length === 0) return DEFAULT_REASONING_EFFORT;
  if (available.includes(DEFAULT_REASONING_EFFORT)) return DEFAULT_REASONING_EFFORT;
  const wanted = EFFORT_RANK[DEFAULT_REASONING_EFFORT];
  if (wanted !== undefined) {
    const atOrBelow = available
      .filter((effort) => EFFORT_RANK[effort] !== undefined && EFFORT_RANK[effort] <= wanted)
      .sort((a, b) => EFFORT_RANK[b] - EFFORT_RANK[a]);
    if (atOrBelow.length > 0) return atOrBelow[0];
  }
  return available[0];
}

async function modelById(modelId) {
  try {
    const models = await fetchModels();
    return models.find((model) => model.id === modelId) || null;
  } catch {
    return null;
  }
}

function postChatCompletions(payload) {
  return fetch(`${upstreamBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

function parseJsonOrEmpty(text) {
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

function catalogEntryFor(model, index) {
  const id = model.id;
  const vision = !!model.vision;
  const levels = reasoningLevelsFor(model);
  return {
    slug: id,
    display_name: `Verboo ${id}`,
    context_window: model.context_window || 1000000,
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: index,
    supported_reasoning_levels: levels,
    base_instructions: BASE_INSTRUCTIONS,
    default_reasoning_level: defaultReasoningLevelFor(levels),
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
  return { models: sorted, default_model: defaultModel, default_reasoning_effort: DEFAULT_REASONING_EFFORT };
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
  const stored = payload.previous_response_id ? responseSessions.get(payload.previous_response_id) : null;
  const previous = stored ? stored.messages : null;
  const messages = previous ? [...previous] : [];
  if (!previous && payload.instructions) messages.push({ role: 'system', content: payload.instructions });

  const input = Array.isArray(payload.input) ? payload.input : [payload.input];
  const pendingToolCalls = [];
  const toolNames = new Map();
  const attachedImages = [];
  let attachedImageBytes = 0;

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

  // Images cannot travel inside a tool message (Verboo ignores them), so they
  // are collected here and attached to one user message after the tool results,
  // each labelled with the tool call it came from.
  const queueImages = (images, label) => {
    for (const image of images) {
      if (attachedImageBytes + image.url.length > MAX_IMAGE_BYTES_PER_REQUEST) {
        attachedImages.push({ url: null, detail: null, label: `${label} [image omitted: image budget for one request exceeded]` });
        continue;
      }
      attachedImageBytes += image.url.length;
      attachedImages.push({ url: image.url, detail: image.detail, label });
    }
  };

  for (const item of input) {
    if (item?.type === 'function_call') {
      pendingToolCalls.push(item);
      toolNames.set(item.call_id || item.id, item.name);
      continue;
    }
    flushToolCalls();

    if (item?.type === 'function_call_output') {
      const outputParts = Array.isArray(item.output) ? item.output : null;
      const images = outputParts ? imagePartsFromContent(outputParts) : [];
      const text = outputParts ? textFromContent(outputParts) : String(item.output ?? '');
      const note = images.length ? `\n[${images.length} image${images.length > 1 ? 's' : ''} attached in the next message]` : '';
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: `${text}${note}` });
      queueImages(images, `${toolNames.get(item.call_id) || 'tool'} ${item.call_id}:`);
      continue;
    }

    const inlineImages = imagePartsFromContent(item?.content);
    if (inlineImages.length) {
      const text = textFromContent(item?.content);
      const parts = text ? [{ type: 'text', text }] : [];
      for (const image of inlineImages) parts.push(imageContentPart(image));
      messages.push({ role: 'user', content: parts });
      continue;
    }

    const message = itemToMessage(item);
    if (message) messages.push(message);
  }
  flushToolCalls();

  if (attachedImages.length) {
    const labels = attachedImages.map((image) => image.label).join('; ');
    const parts = [{ type: 'text', text: `Image output of the tool calls above (${labels}):` }];
    for (const image of attachedImages) {
      parts.push(image.url ? imageContentPart(image) : { type: 'text', text: image.label });
    }
    messages.push({ role: 'user', content: parts });
  }

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
  const imageCount = messages.reduce((total, message) => total + (Array.isArray(message.content) ? message.content.filter(isImagePart).length : 0), 0);
  if (imageCount) {
    await shrinkImagesInMessages(messages);
    console.error(`Verboo adapter: forwarding ${imageCount} image(s) as content parts.`);
  }
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

  // Translate Codex's Responses reasoning.effort into Verboo's
  // chat/completions reasoning_effort, filtered against what this model accepts
  // so a level the router would reject is never sent.
  const requestedEffort = normalizeEffort(payload.reasoning?.effort);
  if (requestedEffort) {
    const accepted = acceptedEffortsFor(await modelById(resolvedModel));
    if (!accepted || accepted.has(requestedEffort)) {
      upstreamPayload.reasoning_effort = requestedEffort;
    } else {
      console.error(`Verboo adapter: ${resolvedModel} does not accept reasoning effort "${requestedEffort}" (accepts: ${[...accepted].join(', ')}); using the model default.`);
    }
  }

  let upstream = await postChatCompletions(upstreamPayload);
  let upstreamText = await upstream.text();
  let upstreamBody = parseJsonOrEmpty(upstreamText);

  // Safety net: if Verboo still rejects the request and an effort level was
  // sent, retry once without it so an unexpected vocabulary mismatch cannot
  // break the turn.
  if (upstream.status === 400 && upstreamPayload.reasoning_effort) {
    console.error(`Verboo adapter: upstream rejected reasoning_effort "${upstreamPayload.reasoning_effort}" for ${resolvedModel}; retrying without it.`);
    delete upstreamPayload.reasoning_effort;
    upstream = await postChatCompletions(upstreamPayload);
    upstreamText = await upstream.text();
    upstreamBody = parseJsonOrEmpty(upstreamText);
  }

  // Second safety net: an image the router refuses (too large, unsupported
  // encoding) must not kill the turn. Retry once with text placeholders.
  if (upstream.status === 400 && messagesContainImages(upstreamPayload.messages)) {
    const stripped = stripImagesFromMessages(upstreamPayload.messages);
    console.error(`Verboo adapter: upstream rejected a request carrying ${stripped.removed} image(s) for ${resolvedModel}; retrying without images.`);
    upstream = await postChatCompletions({ ...upstreamPayload, messages: stripped.messages });
    upstreamText = await upstream.text();
    upstreamBody = parseJsonOrEmpty(upstreamText);
  }
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
  rememberSession(completed.id, [...messages, ...assistantMessages]);

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
