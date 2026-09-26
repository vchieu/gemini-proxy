/** Ước lượng nhanh số token (heuristic, không cần chính xác tuyệt đối) */
function countTextTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part == null) return '';
        if (typeof part.text === 'string') return part.text;
        if (part.text && typeof part.text === 'object') return part.text.value || '';
        if (typeof part.content === 'string') return part.content;
        return '';
      })
      .join('');
  }
  return String(content);
}

/**
 * Ước lượng token cho request.
 * Chấp nhận: mảng messages OpenAI, request body OpenAI ({messages}),
 * string thuần, hoặc body Gemini ({contents, systemInstruction}).
 * @param {any} messages
 * @returns {number}
 */
function estimateTokens(messages) {
  if (messages == null) return 0;
  if (typeof messages === 'string') return countTextTokens(messages);

  // OpenAI request body
  if (!Array.isArray(messages) && typeof messages === 'object' && messages.messages) {
    return estimateTokens(messages.messages);
  }
  // Gemini request body
  if (!Array.isArray(messages) && typeof messages === 'object' && messages.contents) {
    let total = 0;
    for (const c of messages.contents) {
      total += countTextTokens(contentToText(c.parts?.map((p) => p.text || '').join('') ?? c.text ?? ''));
    }
    if (messages.systemInstruction) {
      total += countTextTokens(contentToText(messages.systemInstruction?.parts?.map((p) => p.text || '').join('') ?? ''));
    }
    return total;
  }
  if (Array.isArray(messages)) {
    let total = 0;
    for (const m of messages) {
      if (typeof m === 'string') total += countTextTokens(m);
      else if (m && typeof m === 'object') total += countTextTokens(contentToText(m.content));
      // cộng thêm overhead nhỏ cho role/metadata (theo kinh nghiệm OpenAI ~4 token/message)
      total += 4;
    }
    return total;
  }
  if (typeof messages === 'object') {
    return countTextTokens(JSON.stringify(messages)) / 4 > 0
      ? Math.ceil(JSON.stringify(messages).length / 4)
      : 0;
  }
  return 0;
}

module.exports = { estimateTokens };
