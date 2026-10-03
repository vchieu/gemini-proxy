function normalizeContent(content) {
  if (content == null) return [{ text: '' }];
  if (typeof content === 'string') return [{ text: content }];
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (typeof p === 'string') parts.push({ text: p });
      else if (p.type === 'text') parts.push({ text: p.text || '' });
      else if (p.type === 'image_url') {
        const url = p.image_url?.url || '';
        const m = /^data:([^;]+);base64,(.+)$/.exec(url);
        if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
        // URL http thường: Gemini yêu cầu bytes, không support URL trực tiếp -> bỏ qua kèm text placeholder
        else if (url) parts.push({ text: `[image: ${url}]` });
      }
      else if (p.text !== undefined) parts.push({ text: String(p.text) });
    }
    return parts.length ? parts : [{ text: '' }];
  }
  return [{ text: String(content) }];
}

/** Chuyển OpenAI tools/tool_choice sang Gemini functionDeclarations/toolConfig */

// Whitelist field mà Gemini `Schema` chấp nhận (subset OpenAPI 3.0 — xem
// https://ai.google.dev/api/generate-content#v1beta.Schema).
// Agent (OpenCode/Cline) gửi JSON Schema đầy đủ với additionalProperties,
// exclusiveMinimum, $schema, $defs... -> Gemini trả 400 "Unknown name ..." -> PHẢI lọc.
const GEMINI_SCHEMA_KEYS = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'enum',
  'maxItems', 'minItems', 'properties', 'required', 'minProperties', 'maxProperties',
  'minLength', 'maxLength', 'pattern', 'example', 'anyOf', 'propertyOrdering',
  'default', 'items', 'minimum', 'maximum',
]);
// Field có giá trị tùy ý (không phải sub-schema) -> giữ nguyên, không recurse
const GEMINI_SCHEMA_RAW_KEYS = new Set(['example', 'default', 'enum']);

/**
 * Lọc schema JSON về đúng format Gemini, đệ quy qua properties/items/anyOf.
 * - Bỏ mọi field ngoài whitelist (additionalProperties, exclusiveMinimum, $schema, $defs, $ref, const, ...)
 * - `oneOf` chuyển thành `anyOf` (Gemini chỉ có anyOf)
 * @param {*} value sub-schema (hoặc giá trị bất kỳ)
 * @param {string} [key] tên field chứa value này
 */
function sanitizeGeminiSchema(value, key) {
  if (GEMINI_SCHEMA_RAW_KEYS.has(key)) return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeGeminiSchema(v));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'properties') {
      // properties là map "tên field" -> schema, không phải schema -> recurse từng value
      const src = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      const props = {};
      for (const [name, sub] of Object.entries(src)) props[name] = sanitizeGeminiSchema(sub);
      out.properties = props;
      continue;
    }
    if (k === 'oneOf' || k === 'anyOf') {
      const list = Array.isArray(v) ? v.map((s) => sanitizeGeminiSchema(s)) : [sanitizeGeminiSchema(v)];
      out.anyOf = (out.anyOf || []).concat(list);
      continue;
    }
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue;
    out[k] = sanitizeGeminiSchema(v, k);
  }
  return out;
}

function translateTools(body) {
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  const functionDeclarations = [];
  for (const t of tools) {
    if (t.type === 'function' && t.function) {
      functionDeclarations.push({
        name: t.function.name,
        description: t.function.description || '',
        parameters: sanitizeGeminiSchema(t.function.parameters || { type: 'object', properties: {} }),
      });
    }
  }
  if (functionDeclarations.length === 0) return undefined;

  const out = { functionDeclarations };

  // tool_choice -> toolConfig
  const tc = body.tool_choice;
  if (tc && tc !== 'auto') {
    if (tc === 'none') {
      out.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    } else if (tc === 'required') {
      out.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    } else if (typeof tc === 'object' && tc.type === 'function' && tc.function?.name) {
      out.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [tc.function.name] } };
    }
  }
  return out;
}

/** @param {object} openAiRequestBody @returns {object} geminiRequestBody */
function openAiToGemini(openAiRequestBody) {
  const body = openAiRequestBody || {};
  const messages = body.messages || [];
  const contents = [];
  let systemInstruction = undefined;

  for (const m of messages) {
    const role = m.role;
    if (role === 'system') {
      const text = Array.isArray(m.content)
        ? m.content.map((p) => (typeof p === 'string' ? p : p.text || '')).join('')
        : String(m.content ?? '');
      systemInstruction = { parts: [{ text }] };
    } else if (role === 'assistant') {
      // Assistant message có thể chứa tool_calls
      const parts = normalizeContent(m.content);
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          if (tc.type === 'function' && tc.function) {
            parts.push({
              functionCall: {
                name: tc.function.name,
                args: safeJsonParse(tc.function.arguments) || {},
              },
            });
          }
        }
      }
      contents.push({ role: 'model', parts });
    } else if (role === 'tool') {
      // Tool result -> functionResponse
      const toolCallId = m.tool_call_id;
      const name = extractToolName(toolCallId, m, contents);
      const response = typeof m.content === 'string'
        ? safeJsonParse(m.content) || { result: m.content }
        : { result: m.content };
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: name || 'unknown', response } }],
      });
    } else {
      // user / default
      contents.push({ role: 'user', parts: normalizeContent(m.content) });
    }
  }

  // Gemini yêu cầu contents non-empty
  if (contents.length === 0) contents.push({ role: 'user', parts: [{ text: '' }] });

  const generationConfig = {};
  if (body.temperature !== undefined) generationConfig.temperature = body.temperature;
  if (body.top_p !== undefined) generationConfig.topP = body.top_p;
  if (body.max_tokens !== undefined) generationConfig.maxOutputTokens = body.max_tokens;
  if (body.max_completion_tokens !== undefined) generationConfig.maxOutputTokens = body.max_completion_tokens;
  if (body.stop !== undefined) {
    generationConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }
  if (body.presence_penalty !== undefined) generationConfig.presencePenalty = body.presence_penalty;
  if (body.frequency_penalty !== undefined) generationConfig.frequencyPenalty = body.frequency_penalty;

  const out = { contents };
  if (systemInstruction) out.systemInstruction = systemInstruction;
  if (Object.keys(generationConfig).length > 0) out.generationConfig = generationConfig;

  const tools = translateTools(body);
  if (tools) {
    out.tools = [{ functionDeclarations: tools.functionDeclarations }];
    if (tools.toolConfig) out.toolConfig = tools.toolConfig;
  }
  return out;
}

/**
 * Trích xuất tên function cho 1 tool result.
 * Ưu tiên parse từ tool_call_id (makeToolCallId đã nhúng tên function).
 * FIFO fallback: trả về tên functionCall CHƯA được respond gần nhất theo thứ tự
 * document — quan trọng khi assistant có NHIỀU functionCall (parallel tool_calls),
 * nếu không mọi tool result sẽ map về tên ĐẦU TIÊN.
 */
function extractToolName(toolCallId, toolMsg, contents) {
  const fromId = nameFromToolCallId(toolCallId);
  if (fromId) {
    for (const c of contents) {
      for (const p of c.parts || []) {
        if (p.functionCall && p.functionCall.name === fromId) return fromId;
      }
    }
  }
  // pending = số lần gọi - số lần đã respond, theo từng tên function
  const pending = new Map();
  for (const c of contents) {
    for (const p of c.parts || []) {
      if (p.functionCall) pending.set(p.functionCall.name, (pending.get(p.functionCall.name) || 0) + 1);
      else if (p.functionResponse) {
        const n = pending.get(p.functionResponse.name) || 0;
        if (n > 0) pending.set(p.functionResponse.name, n - 1);
      }
    }
  }
  for (const c of contents) {
    for (const p of c.parts || []) {
      const n = p.functionCall ? pending.get(p.functionCall.name) || 0 : 0;
      if (n > 0) {
        pending.set(p.functionCall.name, n - 1);
        return p.functionCall.name;
      }
    }
  }
  return undefined;
}

/** Parse JSON an toàn, trả về undefined nếu lỗi */
function safeJsonParse(str) {
  if (typeof str !== 'string') return undefined;
  try { return JSON.parse(str); } catch (_) { return undefined; }
}

function mapFinishReason(fr) {
  switch (fr) {
    case 'STOP': return 'stop';
    case 'MAX_TOKENS': return 'length';
    case 'SAFETY': return 'content_filter';
    case 'RECITATION': return 'content_filter';
    default: return 'stop';
  }
}

/** Tạo tool_call_id — nhúng tên function (encoded) để map lại đúng khi client trả tool result, kể cả parallel/out-of-order */
function makeToolCallId(name) {
  return `call_${encodeURIComponent(name)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Đọc tên function từ tool_call_id do makeToolCallId tạo; trả undefined với id kiểu cũ (call_<hash>) */
function nameFromToolCallId(toolCallId) {
  if (typeof toolCallId !== 'string') return undefined;
  const m = /^call_(.+)_([a-z0-9]{2,16})$/.exec(toolCallId);
  if (!m) return undefined;
  try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; }
}

/** Chuyển Gemini functionCall sang OpenAI tool_calls */
function extractToolCalls(parts) {
  const toolCalls = [];
  for (const p of parts) {
    if (p.functionCall) {
      toolCalls.push({
        id: makeToolCallId(p.functionCall.name),
        type: 'function',
        function: {
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args || {}),
        },
      });
    }
  }
  return toolCalls.length > 0 ? toolCalls : undefined;
}

/** @param {object} geminiResponseBody @param {string} modelName @returns {object} openAiResponseBody */
function geminiToOpenAi(geminiResponseBody, modelName) {
  const body = geminiResponseBody || {};
  const candidates = body.candidates || [];
  const first = candidates[0] || {};
  const parts = first?.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('');
  const finishReason = mapFinishReason(first.finishReason || 'STOP');
  const usage = body.usageMetadata || {};
  const id = `chatcmpl-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const toolCalls = extractToolCalls(parts);
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelName || 'gemini',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls ? 'tool_calls' : finishReason,
      },
    ],
    usage: {
      prompt_tokens: usage.promptTokenCount || 0,
      completion_tokens: usage.candidatesTokenCount || 0,
      total_tokens: usage.totalTokenCount || 0,
    },
  };
}

/** Dịch 1 chunk Gemini streaming sang chunk OpenAI SSE. `toolCallIndexOffset`: index bắt đầu của tool_calls (tăng dần giữa các chunk — OpenAI streaming yêu cầu index duy nhất) */
function geminiChunkToOpenAiChunk(geminiChunk, modelName, streamId, created, toolCallIndexOffset = 0) {
  const candidates = geminiChunk.candidates || [];
  const first = candidates[0] || {};
  const parts = first?.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('');
  const finish = first.finishReason ? mapFinishReason(first.finishReason) : null;
  const toolCalls = extractToolCalls(parts);
  return {
    id: streamId,
    object: 'chat.completion.chunk',
    created,
    model: modelName || 'gemini',
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          content: text || null,
          ...(toolCalls ? { tool_calls: toolCalls.map((tc, i) => ({ index: toolCallIndexOffset + i, ...tc })) } : {}),
        },
        finish_reason: toolCalls ? 'tool_calls' : finish,
      },
    ],
  };
}

module.exports = { openAiToGemini, geminiToOpenAi, geminiChunkToOpenAiChunk };
