#!/usr/bin/env node

/**
 * zai-codex-bridge
 *
 * Local proxy that translates OpenAI Responses API format to Z.AI Chat Completions format.
 * Allows Codex to use Z.AI GLM models through the /responses endpoint.
 *
 * Author: Davide A. Guglielmi
 * License: MIT
 */

const http = require('http');
const { randomUUID } = require('crypto');

// Configuration from environment
const PORT = parseInt(process.env.PORT || '31415', 10);
const HOST = process.env.HOST || '127.0.0.1';
const ZAI_BASE_URL = process.env.ZAI_BASE_URL || 'https://api.z.ai/api/coding/paas/v4';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'glm-4.7';
const LOG_STREAM_RAW = process.env.LOG_STREAM_RAW === '1';
const LOG_STREAM_MAX = parseInt(process.env.LOG_STREAM_MAX || '800', 10);
const SUPPRESS_ASSISTANT_TEXT_WHEN_TOOLS = process.env.SUPPRESS_ASSISTANT_TEXT_WHEN_TOOLS === '1';
const DEFER_OUTPUT_TEXT_UNTIL_DONE = process.env.DEFER_OUTPUT_TEXT_UNTIL_DONE === '1';

// Env toggles for compatibility
const ALLOW_SYSTEM = process.env.ALLOW_SYSTEM === '1';
const ALLOW_TOOLS_ENV = process.env.ALLOW_TOOLS === '1';

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function buildResponseObject({
  id,
  model,
  status,
  created_at,
  completed_at = null,
  input = [],
  output = [],
  tools = [],
}) {
  // Struttura compatibile con Responses API per Codex CLI
  return {
    id,
    object: 'response',
    created_at,
    status,
    completed_at,
    error: null,
    incomplete_details: null,
    input,
    instructions: null,
    max_output_tokens: null,
    model,
    output,
    previous_response_id: null,
    reasoning_effort: null,
    store: false,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools,
    top_p: 1,
    truncation: 'disabled',
    usage: null,
    user: null,
    metadata: {},
  };
}

/**
 * Logger
 */
function log(level, ...args) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  if (levels[level] >= levels[LOG_LEVEL]) {
    console.error(`[${level.toUpperCase()}]`, new Date().toISOString(), ...args);
  }
}

/**
 * Detect if request body is Responses format or Chat format
 */
function detectFormat(body) {
  if (body.instructions !== undefined || body.input !== undefined) {
    return 'responses';
  }
  if (body.messages !== undefined) {
    return 'chat';
  }
  return 'unknown';
}

/**
 * Detect if request carries tool-related data
 */
function requestHasTools(request) {
  if (!request || typeof request !== 'object') return false;

  if (Array.isArray(request.tools) && request.tools.length > 0) return true;
  if (request.tool_choice) return true;

  if (Array.isArray(request.input)) {
    for (const item of request.input) {
      if (!item) continue;
      if (item.type === 'function_call_output') return true;
      if (Array.isArray(item.tool_calls) && item.tool_calls.length > 0) return true;
      if (item.tool_call_id) return true;
    }
  }

  if (Array.isArray(request.messages)) {
    for (const msg of request.messages) {
      if (!msg) continue;
      if (msg.role === 'tool') return true;
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true;
      if (msg.tool_call_id) return true;
    }
  }

  return false;
}

function summarizeTools(tools, limit = 8) {
  if (!Array.isArray(tools)) return null;
  const types = {};
  const names = [];

  for (const tool of tools) {
    const type = tool?.type || 'unknown';
    types[type] = (types[type] || 0) + 1;
    if (names.length < limit) {
      if (type === 'function') {
        names.push(tool?.function?.name || tool?.name || '(missing_name)');
      } else {
        names.push(type);
      }
    }
  }

  return { count: tools.length, types, sample_names: names };
}

function summarizeToolShape(tool) {
  if (!tool || typeof tool !== 'object') return null;
  return {
    keys: Object.keys(tool),
    type: tool.type,
    name: tool.name,
    functionKeys: tool.function && typeof tool.function === 'object' ? Object.keys(tool.function) : null,
    functionName: tool.function?.name
  };
}

/**
 * Flatten content parts to string - supports text, input_text, output_text
 */
function flattenContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const texts = content
      .filter(p =>
        (p && (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text')) && p.text
      )
      .map(p => p.text);
    if (texts.length) return texts.join('\n');
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  if (content == null) return '';
  return String(content);
}

/**
 * Extract reasoning text from upstream payloads (message or delta).
 */
function extractReasoningText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const candidates = ['reasoning_content', 'reasoning', 'thinking', 'thought'];
  for (const key of candidates) {
    const val = obj[key];
    if (typeof val === 'string' && val.length) return val;
  }
  return '';
}

/**
 * Compute a safe incremental delta for providers that sometimes stream
 * the full content-so-far instead of true deltas.
 */
function computeDelta(prev, incoming) {
  if (!incoming) return { delta: '', next: prev };
  if (!prev) return { delta: incoming, next: incoming };

  // Full-content streaming: incoming is the full buffer so far.
  if (incoming.startsWith(prev)) {
    return { delta: incoming.slice(prev.length), next: incoming };
  }

  // Duplicate chunk (provider repeated last fragment).
  if (prev.endsWith(incoming)) {
    return { delta: '', next: prev };
  }

  // Overlap fix: avoid duplicated boundary text.
  const max = Math.min(prev.length, incoming.length);
  for (let i = max; i > 0; i--) {
    if (prev.endsWith(incoming.slice(0, i))) {
      const delta = incoming.slice(i);
      return { delta, next: prev + delta };
    }
  }

  // Fallback: treat as incremental.
  return { delta: incoming, next: prev + incoming };
}

/**
 * Translate Responses format to Chat Completions format
 */
function translateResponsesToChat(request, allowTools) {
  const messages = [];

  // Add system message from instructions (with ALLOW_SYSTEM toggle)
  if (request.instructions) {
    if (ALLOW_SYSTEM) {
      messages.push({
        role: 'system',
        content: request.instructions
      });
    } else {
      // Prepend to first user message for Z.ai compatibility
      const instr = String(request.instructions).trim();
      if (messages.length && messages[0].role === 'user') {
        messages[0].content = `[INSTRUCTIONS]\n${instr}\n[/INSTRUCTIONS]\n\n${messages[0].content || ''}`;
      } else {
        messages.unshift({ role: 'user', content: `[INSTRUCTIONS]\n${instr}\n[/INSTRUCTIONS]` });
      }
    }
  }

  // Handle input: can be string (simple user message) or array (message history)
  if (request.input) {
    if (typeof request.input === 'string') {
      // Simple string input -> user message
      messages.push({
        role: 'user',
        content: request.input
      });
    } else if (Array.isArray(request.input)) {
      // Array of ResponseItem objects
      for (const item of request.input) {
        // Handle function_call_output items (tool responses) - only if allowTools
        if (allowTools && item.type === 'function_call_output') {
          const toolMsg = {
            role: 'tool',
            tool_call_id: item.call_id || item.tool_call_id || '',
            content: ''
          };

          // Extract content from output or content field
          if (item.output !== undefined) {
            toolMsg.content = typeof item.output === 'string'
              ? item.output
              : JSON.stringify(item.output);
          } else if (item.content !== undefined) {
            toolMsg.content = typeof item.content === 'string'
              ? item.content
              : JSON.stringify(item.content);
          }

          messages.push(toolMsg);
          continue;
        }

        // Only process items with a 'role' field (Message items)
        // Skip Reasoning, FunctionCall, LocalShellCall, etc.
        if (!item.role) continue;

        // Map non-standard roles to Z.AI-compatible roles
        // Z.AI accepts: system, user, assistant, tool
        let role = item.role;
        if (role === 'developer') {
          role = 'user'; // Map developer to user
        } else if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
          // Skip any other non-standard roles
          continue;
        }

        const msg = {
          role: role,
          content: flattenContent(item.content)
        };

        // Handle tool calls if present (only if allowTools)
        if (allowTools && item.tool_calls && Array.isArray(item.tool_calls)) {
          msg.tool_calls = item.tool_calls;
        }

        // Handle tool call ID for tool responses (only if allowTools)
        if (allowTools && item.tool_call_id) {
          msg.tool_call_id = item.tool_call_id;
        }

        messages.push(msg);
      }
    }
  }

  // Build chat request
  // Normalize model name to lowercase (Z.AI requirement)
  const model = (request.model || 'glm-4.7').toLowerCase();
  const chatRequest = {
    model: model,
    messages: messages,
    stream: request.stream !== false // default true
  };

  // Pass through reasoning controls when present (provider may ignore unknown fields)
  if (request.reasoning !== undefined) {
    chatRequest.reasoning = request.reasoning;
    if (request.reasoning && typeof request.reasoning === 'object' && request.reasoning.effort !== undefined) {
      chatRequest.reasoning_effort = request.reasoning.effort;
    }
  }

  // Map optional fields
  if (request.max_output_tokens) {
    chatRequest.max_tokens = request.max_output_tokens;
  } else if (request.max_tokens) {
    chatRequest.max_tokens = request.max_tokens;
  }

  if (request.temperature !== undefined) {
    chatRequest.temperature = request.temperature;
  }

  if (request.top_p !== undefined) {
    chatRequest.top_p = request.top_p;
  }

  // Tools handling (only if allowTools)
  if (allowTools && request.tools && Array.isArray(request.tools)) {
    const originalCount = request.tools.length;
    const normalized = [];

    for (const tool of request.tools) {
      if (!tool || tool.type !== 'function') continue;
      const fn = tool.function && typeof tool.function === 'object' ? tool.function : null;
      const name = (fn?.name || tool.name || '').trim();
      if (!name) continue;

      // Prefer nested function fields, fall back to top-level ones if present
      const description = fn?.description ?? tool.description;
      const parameters = fn?.parameters ?? tool.parameters ?? { type: 'object', properties: {} };

      const functionObj = { name, parameters };
      if (description) functionObj.description = description;

      // Send minimal tool schema for upstream compatibility
      normalized.push({
        type: 'function',
        function: functionObj
      });
    }

    chatRequest.tools = normalized;

    const dropped = originalCount - chatRequest.tools.length;
    if (dropped > 0) {
      log('warn', `Dropped ${dropped} non-function or invalid tools for upstream compatibility`);
    }

    // Only add tools array if there are valid tools
    if (chatRequest.tools.length === 0) {
      delete chatRequest.tools;
    }
  }

  if (allowTools && request.tool_choice) {
    chatRequest.tool_choice = request.tool_choice;
    if (!chatRequest.tools || chatRequest.tools.length === 0) {
      delete chatRequest.tool_choice;
    }
  }

  log('debug', 'Translated Responses->Chat:', {
    messagesCount: messages.length,
    model: chatRequest.model,
    stream: chatRequest.stream
  });

  return chatRequest;
}

/**
 * Translate Chat Completions response to Responses format
 * Handles both output_text and reasoning_text content
 * Handles tool_calls if present (only if allowTools)
 */
function translateChatToResponses(chatResponse, responsesRequest, ids, allowTools) {
  const msg = chatResponse.choices?.[0]?.message ?? {};
  const outputText = msg.content ?? '';
  const reasoningText = extractReasoningText(msg);

  const createdAt = ids?.createdAt ?? nowSec();
  const responseId = ids?.responseId ?? `resp_${randomUUID().replace(/-/g, '')}`;
  const msgId = ids?.msgId ?? `msg_${randomUUID().replace(/-/g, '')}`;

  const content = [];
  if (reasoningText) {
    content.push({ type: 'reasoning_text', text: reasoningText, annotations: [] });
  }
  if (outputText) {
    content.push({ type: 'output_text', text: outputText, annotations: [] });
  }

  const msgItem = {
    id: msgId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content,
  };

  // Build output array: message item (if any) + any function_call items
  const finalOutput = [];

  const hasToolCalls = allowTools && msg.tool_calls && Array.isArray(msg.tool_calls);
  if (content.length > 0 || !hasToolCalls) {
    finalOutput.push(msgItem);
  }

  // Handle tool_calls (only if allowTools)
  if (hasToolCalls) {
    for (const tc of msg.tool_calls) {
      const callId = tc.id || `call_${randomUUID().replace(/-/g, '')}`;
      const name = tc.function?.name || '';
      const args = tc.function?.arguments || '';

      // Enhanced logging for FunctionCall debugging
      log('info', `FunctionCall: ${name}(${callId}) args_length=${args.length}`);
    }
  }

  return buildResponseObject({
    id: responseId,
    model: responsesRequest?.model || chatResponse.model || DEFAULT_MODEL,
    status: 'completed',
    created_at: createdAt,
    completed_at: nowSec(),
    input: responsesRequest?.input || [],
    output: finalOutput,
    tools: responsesRequest?.tools || [],
  });
}

/**
 * Extract and normalize Bearer token
 */
function getBearer(raw) {
  if (!raw) return '';
  let t = String(raw).trim();
  if (!t) return '';
  // If already "Bearer xxx" keep it, otherwise add it
  if (!t.toLowerCase().startsWith('bearer ')) t = `Bearer ${t}`;
  return t;
}

/**
 * Pick auth token from env ZAI_API_KEY (priority) or incoming headers
 */
function pickAuth(incomingHeaders) {
  // PRIORITY: env ZAI_API_KEY (force correct key) -> incoming header
  const envTok = (process.env.ZAI_API_KEY || '').trim();
  if (envTok) return getBearer(envTok);

  const h = (incomingHeaders['authorization'] || incomingHeaders['Authorization'] || '').trim();
  return getBearer(h);
}

/**
 * Make upstream request to Z.AI
 */
async function makeUpstreamRequest(path, body, headers) {
  // Ensure base URL ends with / for proper path concatenation
  const baseUrl = ZAI_BASE_URL.endsWith('/') ? ZAI_BASE_URL : ZAI_BASE_URL + '/';
  // Remove leading slash from path to avoid replacing base URL path
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  const url = new URL(cleanPath, baseUrl);

  const auth = pickAuth(headers);
  const upstreamHeaders = {
    'Content-Type': 'application/json',
    'Authorization': auth,
    'Accept-Encoding': 'identity'  // Disable compression to avoid gzip issues
  };

  log('info', 'Upstream request:', {
    url: url.href,
    path: path,
    cleanPath: cleanPath,
    base: ZAI_BASE_URL,
    auth_len: auth.length,
    auth_prefix: auth.slice(0, 14), // "Bearer xxxxxx"
    bodyKeys: Object.keys(body),
    bodyPreview: JSON.stringify(body).substring(0, 800),
    messagesCount: body.messages?.length || 0,
    allRoles: body.messages?.map(m => m.role) || []
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: upstreamHeaders,
    body: JSON.stringify(body)
  });

  return response;
}

/**
 * Handle streaming response from Z.AI with proper Responses API event format
 * Separates reasoning_content, content, and tool_calls into distinct events
 */
async function streamChatToResponses(upstreamBody, res, responsesRequest, ids, allowTools) {
  const decoder = new TextDecoder();
  const reader = upstreamBody.getReader();
  let buffer = '';

  const createdAt = ids.createdAt;
  const responseId = ids.responseId;
  const msgId = ids.msgId;

  let seq = 1;
  const OUTPUT_INDEX = 0;
  const CONTENT_INDEX = 0;

  function sse(obj) {
    if (obj.sequence_number == null) obj.sequence_number = seq++;
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  }

  // response.created / response.in_progress
  const baseResp = buildResponseObject({
    id: responseId,
    model: responsesRequest?.model || DEFAULT_MODEL,
    status: 'in_progress',
    created_at: createdAt,
    completed_at: null,
    input: responsesRequest?.input || [],
    output: [],
    tools: responsesRequest?.tools || [],
  });

  sse({ type: 'response.created', response: baseResp });
  sse({ type: 'response.in_progress', response: baseResp });

  // output_item.added + content_part.added (output_text)
  const msgItemInProgress = {
    id: msgId,
    type: 'message',
    status: 'in_progress',
    role: 'assistant',
    content: [],
  };

  sse({
    type: 'response.output_item.added',
    output_index: OUTPUT_INDEX,
    item: msgItemInProgress,
  });

  // content_part.added emitted only if we receive output_text
  let contentPartAdded = false;

  let out = '';
  let reasoning = '';
  let sawToolCalls = false;

  // Tool call tracking (only if allowTools)
  const toolCallsMap = new Map(); // index -> { callId, name, outputIndex, arguments, partialArgs }
  const toolCallsById = new Map(); // callId -> index
  const TOOL_BASE_INDEX = 1; // After message item
  let nextToolIndex = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const evt of events) {
      const lines = evt.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') {
          // termina upstream
          continue;
        }

        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }

        if (LOG_STREAM_RAW) {
          const preview = JSON.stringify(chunk);
          log('debug', 'Upstream chunk:', preview.length > LOG_STREAM_MAX ? preview.slice(0, LOG_STREAM_MAX) + '…' : preview);
        }

        const delta = chunk.choices?.[0]?.delta || {};

        // Handle tool_calls (only if allowTools)
        if (allowTools && delta.tool_calls && Array.isArray(delta.tool_calls)) {
          if (SUPPRESS_ASSISTANT_TEXT_WHEN_TOOLS) {
            sawToolCalls = true;
          }
          for (const tc of delta.tool_calls) {
            let index = tc.index;
            const tcId = tc.id;

            if (index == null) {
              if (tcId && toolCallsById.has(tcId)) {
                index = toolCallsById.get(tcId);
              } else {
                index = nextToolIndex++;
              }
            } else if (index >= nextToolIndex) {
              nextToolIndex = index + 1;
            }

            if (!toolCallsMap.has(index)) {
              // New tool call - send output_item.added
              const callId = tcId || `call_${randomUUID().replace(/-/g, '')}`;
              const name = tc.function?.name || '';
              const outputIndex = TOOL_BASE_INDEX + index;

              toolCallsMap.set(index, {
                callId,
                name,
                outputIndex,
                arguments: '',
                partialArgs: ''
              });
              if (callId) toolCallsById.set(callId, index);

              const fnItemInProgress = {
                id: callId,
                type: 'function_call',
                call_id: callId,
                name: name,
                arguments: '',
              };

              sse({
                type: 'response.output_item.added',
                output_index: outputIndex,
                item: fnItemInProgress,
              });

              if (name) {
                sse({
                  type: 'response.function_call_name.done',
                  item_id: callId,
                  output_index: outputIndex,
                  name: name,
                });
              }
            }

            const tcData = toolCallsMap.get(index);

            // Handle name update if it comes later
            if (tc.function?.name && !tcData.name) {
              tcData.name = tc.function.name;
              sse({
                type: 'response.function_call_name.done',
                item_id: tcData.callId,
                output_index: tcData.outputIndex,
                name: tcData.name,
              });
            }

            // Handle arguments delta
            if (tc.function?.arguments && typeof tc.function.arguments === 'string') {
              tcData.partialArgs += tc.function.arguments;

              sse({
                type: 'response.function_call_arguments.delta',
                item_id: tcData.callId,
                output_index: tcData.outputIndex,
                delta: tc.function.arguments,
              });
            }

            // Check if this tool call is done (finish_reason comes later in the choice)
            const finishReason = chunk.choices?.[0]?.finish_reason;
            if (finishReason === 'tool_calls' || (tc.function?.arguments && tc.function.arguments.length > 0 && chunk.choices?.[0]?.delta !== null)) {
              tcData.arguments = tcData.partialArgs;

              sse({
                type: 'response.function_call_arguments.done',
                item_id: tcData.callId,
                output_index: tcData.outputIndex,
                arguments: tcData.arguments,
              });

              const fnItemDone = {
                id: tcData.callId,
                type: 'function_call',
                call_id: tcData.callId,
                name: tcData.name,
                arguments: tcData.arguments,
              };

              sse({
                type: 'response.output_item.done',
                output_index: tcData.outputIndex,
                item: fnItemDone,
              });
            }
          }
          // Skip to next iteration after handling tool_calls
          continue;
        }

        // NON mescolare reasoning in output_text
        const reasoningDelta = extractReasoningText(delta);
        if (reasoningDelta) {
          const computed = computeDelta(reasoning, reasoningDelta);
          reasoning = computed.next;
          if (computed.delta.length) {
            sse({
              type: 'response.reasoning_text.delta',
              item_id: msgId,
              output_index: OUTPUT_INDEX,
              content_index: CONTENT_INDEX,
              delta: computed.delta,
            });
          }
        }

        if (typeof delta.content === 'string' && delta.content.length) {
          const computed = computeDelta(out, delta.content);
          out = computed.next;
          if (!DEFER_OUTPUT_TEXT_UNTIL_DONE
            && !(SUPPRESS_ASSISTANT_TEXT_WHEN_TOOLS && sawToolCalls)
            && computed.delta.length) {
            if (!contentPartAdded) {
              sse({
                type: 'response.content_part.added',
                item_id: msgId,
                output_index: OUTPUT_INDEX,
                content_index: CONTENT_INDEX,
                part: { type: 'output_text', text: '', annotations: [] },
              });
              contentPartAdded = true;
            }
            sse({
              type: 'response.output_text.delta',
              item_id: msgId,
              output_index: OUTPUT_INDEX,
              content_index: CONTENT_INDEX,
              delta: computed.delta,
            });
          }
        }
      }
    }
  }

  const includeOutputText = out.length > 0 && !(SUPPRESS_ASSISTANT_TEXT_WHEN_TOOLS && sawToolCalls);
  if (!includeOutputText && out.length > 0) {
    log('info', 'Suppressing assistant output_text due to tool_calls');
  }

  // done events
  if (reasoning.length) {
    sse({
      type: 'response.reasoning_text.done',
      item_id: msgId,
      output_index: OUTPUT_INDEX,
      content_index: CONTENT_INDEX,
      text: reasoning,
    });
  }

  if (includeOutputText) {
    sse({
      type: 'response.output_text.done',
      item_id: msgId,
      output_index: OUTPUT_INDEX,
      content_index: CONTENT_INDEX,
      text: out,
    });

    if (contentPartAdded) {
      sse({
        type: 'response.content_part.done',
        item_id: msgId,
        output_index: OUTPUT_INDEX,
        content_index: CONTENT_INDEX,
        part: { type: 'output_text', text: out, annotations: [] },
      });
    }
  }

  const msgContent = [];
  if (reasoning.length) {
    msgContent.push({ type: 'reasoning_text', text: reasoning, annotations: [] });
  }
  if (includeOutputText) {
    msgContent.push({ type: 'output_text', text: out, annotations: [] });
  }

  const msgItemDone = {
    id: msgId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: msgContent,
  };

  sse({
    type: 'response.output_item.done',
    output_index: OUTPUT_INDEX,
    item: msgItemDone,
  });

  // Build final output array: message item (if any) + any function_call items
  const finalOutput = [];
  if (msgContent.length > 0 || toolCallsMap.size === 0) {
    finalOutput.push(msgItemDone);
  }

  const completed = buildResponseObject({
    id: responseId,
    model: responsesRequest?.model || DEFAULT_MODEL,
    status: 'completed',
    created_at: createdAt,
    completed_at: nowSec(),
    input: responsesRequest?.input || [],
    output: finalOutput,
    tools: responsesRequest?.tools || [],
  });

  sse({ type: 'response.completed', response: completed });
  res.end();

  log('info', `Stream completed - ${out.length} output, ${reasoning.length} reasoning, ${toolCallsMap.size} tool_calls`);
}

/**
 * Handle POST requests
 */
async function handlePostRequest(req, res) {
  // Use normalized pathname instead of raw req.url
  const { pathname: path } = new URL(req.url, 'http://127.0.0.1');

  // Handle both /responses and /v1/responses, /chat/completions and /v1/chat/completions
  const isResponses = (path === '/responses' || path === '/v1/responses');
  const isChat = (path === '/chat/completions' || path === '/v1/chat/completions');

  if (!isResponses && !isChat) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found', path }));
    return;
  }

  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
  }

  let request;
  try {
    request = JSON.parse(body);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  const hasTools = requestHasTools(request);
  const allowTools = ALLOW_TOOLS_ENV || hasTools;

  log('info', 'Incoming request:', {
    path,
    format: detectFormat(request),
    model: request.model,
    allowTools,
    toolsPresent: hasTools,
    authHeader: req.headers['authorization'] || req.headers['Authorization'] || 'none'
  });
  if (hasTools) {
    log('debug', 'Tools summary:', summarizeTools(request.tools));
    if (request.tools && request.tools[0]) {
      log('debug', 'Tool[0] shape:', summarizeToolShape(request.tools[0]));
    }
  }

  let upstreamBody;
  const format = detectFormat(request);

  if (format === 'responses') {
    // Translate Responses to Chat
    upstreamBody = translateResponsesToChat(request, allowTools);
  } else if (format === 'chat') {
    // Pass through Chat format
    upstreamBody = request;
  } else {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unknown request format' }));
    return;
  }

  try {
    const upstreamResponse = await makeUpstreamRequest(
      '/chat/completions',
      upstreamBody,
      req.headers
    );

    if (!upstreamResponse.ok) {
      const errorBody = await upstreamResponse.text();
      const status = upstreamResponse.status;
      log('error', 'Upstream error:', {
        status: status,
        body: errorBody.substring(0, 200)
      });

      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Upstream request failed',
        upstream_status: status,
        upstream_body: errorBody
      }));
      return;
    }

    // Handle streaming response
    if (upstreamBody.stream) {
      const ids = {
        createdAt: nowSec(),
        responseId: `resp_${randomUUID().replace(/-/g, '')}`,
        msgId: `msg_${randomUUID().replace(/-/g, '')}`,
      };
      log('info', 'Starting streaming response');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      try {
        await streamChatToResponses(upstreamResponse.body, res, request, ids, allowTools);
        log('info', 'Streaming completed');
      } catch (e) {
        log('error', 'Streaming error:', e);
      }
    } else {
      // Non-streaming response
      const chatResponse = await upstreamResponse.json();

      const ids = {
        createdAt: nowSec(),
        responseId: `resp_${randomUUID().replace(/-/g, '')}`,
        msgId: `msg_${randomUUID().replace(/-/g, '')}`,
      };

      const response = translateChatToResponses(chatResponse, request, ids, allowTools);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    }
  } catch (error) {
    log('error', 'Request failed:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
}

/**
 * Create HTTP server
 */
const server = http.createServer(async (req, res) => {
  // Use normalized pathname
  const { pathname } = new URL(req.url, 'http://127.0.0.1');

  log('debug', 'Request:', req.method, pathname);

  // Health check
  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Models endpoint (Codex often calls /v1/models)
  if ((pathname === '/v1/models' || pathname === '/models') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'GLM-4.7', object: 'model' },
        { id: 'glm-4.7', object: 'model' }
      ]
    }));
    return;
  }

  // POST requests
  if (req.method === 'POST') {
    await handlePostRequest(req, res);
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

/**
 * Start server
 */
server.listen(PORT, HOST, () => {
  log('info', `zai-codex-bridge listening on http://${HOST}:${PORT}`);
  log('info', `Proxying to Z.AI at: ${ZAI_BASE_URL}`);
  log('info', `Health check: http://${HOST}:${PORT}/health`);
  log('info', `Models endpoint: http://${HOST}:${PORT}/v1/models`);
});
