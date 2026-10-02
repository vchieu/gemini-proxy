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
function translateTools(body) {
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  const functionDeclarations = [];
  for (const t of tools) {
    if (t.type === 'function' && t.function) {
      functionDeclarations.push({
        name: t.function.name,
        description: t.function.description || '',
        parameters: t.function.parameters || { type: 'object', properties: {} },
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

/** Trích xuất tên function từ tool_call_id hoặc tìm trong contents */
function extractToolName(toolCallId, toolMsg, contents) {
  // tool_call_id thường dạng "call_<hash>" — không chứa tên function
  // Tìm trong contents: functionCall gần nhất chưa được respond
  for (let i = contents.length - 1; i >= 0; i--) {
    const parts = contents[i].parts || [];
    for (const p of parts) {
      if (p.functionCall) return p.functionCall.name;
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

/** Chuyển Gemini functionCall sang OpenAI tool_calls */
function extractToolCalls(parts) {
  const toolCalls = [];
  for (const p of parts) {
    if (p.functionCall) {
      toolCalls.push({
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
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

/** Dịch 1 chunk Gemini streaming sang chunk OpenAI SSE */
function geminiChunkToOpenAiChunk(geminiChunk, modelName, streamId, created) {
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
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls ? 'tool_calls' : finish,
      },
    ],
  };
}

module.exports = { openAiToGemini, geminiToOpenAi, geminiChunkToOpenAiChunk };
