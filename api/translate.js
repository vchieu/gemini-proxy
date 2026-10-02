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
      contents.push({ role: 'model', parts: normalizeContent(m.content) });
    } else if (role === 'tool') {
      contents.push({ role: 'user', parts: normalizeContent(m.content) });
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
  return out;
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
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelName || 'gemini',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: finishReason,
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
  return {
    id: streamId,
    object: 'chat.completion.chunk',
    created,
    model: modelName || 'gemini',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: text },
        finish_reason: finish,
      },
    ],
  };
}

module.exports = { openAiToGemini, geminiToOpenAi, geminiChunkToOpenAiChunk };
