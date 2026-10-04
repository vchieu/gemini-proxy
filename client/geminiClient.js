const { extractRetryDelaySeconds } = require('./errorParser');
const { logger } = require('../utils/logger');

class Gemini429Error extends Error {
  constructor(message, { rawMessage, details, retryDelaySeconds, status } = {}) {
    super(message);
    this.name = 'Gemini429Error';
    this.status = status || 429;
    this.rawMessage = rawMessage || message;
    this.details = details;
    this.retryDelaySeconds = retryDelaySeconds;
  }
}

class GeminiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.body = body;
  }
}

function buildUrl(model, apiKey, stream) {
  const action = stream ? 'streamGenerateContent' : 'generateContent';
  return (
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.name)}` +
    `:${action}?key=${encodeURIComponent(apiKey)}` +
    (stream ? '&alt=sse' : '')
  );
}

const QUOTA_RE = /quota|rate|limit|retry/i;

/**
 * Dựng lỗi từ 1 HTTP response KHÔNG ok, dựa trên `text` ĐÃ ĐỌC (body chỉ được
 * đọc đúng 1 lần ở caller — đọc lần 2 trên Response sẽ ném TypeError "Body is unusable").
 * - 429, hoặc 403 kèm message quota/rate/limit/retry -> Gemini429Error (có retryDelaySeconds)
 * - còn lại -> GeminiError `Gemini error <status>: <text>` (prefix này được
 *   fallbackLoop.isTransientUpstream dùng để nhận diện 5xx upstream) + `.body` là
 *   JSON Google đã parse (undefined nếu body không phải JSON object).
 * @param {number} status
 * @param {string} text
 * @returns {Gemini429Error | GeminiError}
 */
function buildHttpError(status, text) {
  let parsed;
  try { parsed = text ? JSON.parse(text) : undefined; } catch (_) { parsed = undefined; }
  const isObj = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  const errObj = isObj && parsed.error && typeof parsed.error === 'object' ? parsed.error : undefined;
  const msg = (errObj && errObj.message) || text || `HTTP ${status}`;

  // Gemini đôi khi trả 403 kèm quota message — coi như 429
  if (status === 429 || (status === 403 && QUOTA_RE.test(msg))) {
    const retryDelaySeconds = extractRetryDelaySeconds(
      errObj ? parsed : { error: { message: msg, details: undefined } }
    );
    return new Gemini429Error(msg, {
      rawMessage: msg,
      details: errObj ? errObj.details : undefined,
      retryDelaySeconds,
      status: 429,
    });
  }
  return new GeminiError(`Gemini error ${status}: ${text}`, {
    status,
    body: isObj ? parsed : undefined,
  });
}

/**
 * Gọi Gemini generateContent API với 1 key + model cụ thể.
 * @param {ApiKeyConfig} key
 * @param {ModelConfig} model
 * @param {object} geminiRequestBody  // đã ở format Gemini (contents, generationConfig)
 * @param {{timeoutMs?: number}} options
 * @returns {Promise<object>}  // response Gemini gốc, có usageMetadata
 * @throws {Gemini429Error} khi bị rate limit — error object cần có `.rawMessage` và `.details`
 * @throws {GeminiError} lỗi HTTP khác (`.status`, `.body` = JSON Google nếu parse được)
 */
async function callGemini(key, model, geminiRequestBody, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res, text;
  try {
    res = await fetch(buildUrl(model, key.api_key, false), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiRequestBody),
      signal: controller.signal,
    });
    text = await res.text(); // đọc body ĐÚNG 1 LẦN; timeout phủ cả lúc đọc body (#5)
  } catch (e) {
    if (e.name === 'AbortError') throw new GeminiError(`Gemini request timeout after ${timeoutMs}ms`, { status: 504 });
    throw new GeminiError(`Gemini network error: ${e.message}`, { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw buildHttpError(res.status, text);

  let body;
  try { body = text ? JSON.parse(text) : {}; } catch (_) { body = { raw: text }; }
  return body;
}

/**
 * Gọi Gemini streaming (SSE). Trả về object mới bọc stream, reset idle timeout mỗi chunk.
 * KHÔNG trả Response gốc vì Response.body của undici chỉ có getter -> gán bị bỏ qua im lặng.
 * @returns {Promise<{ ok: boolean, status: number, headers: object, body: ReadableStream }>}
 */
async function callGeminiStream(key, model, geminiRequestBody, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  const controller = new AbortController();
  let timedOut = false;
  const onTimeout = () => { timedOut = true; controller.abort(); };
  let timer = setTimeout(onTimeout, timeoutMs);

  let res;
  try {
    res = await fetch(buildUrl(model, key.api_key, true), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiRequestBody),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (timedOut || e.name === 'AbortError') throw new GeminiError(`Gemini stream timeout after ${timeoutMs}ms`, { status: 504 });
    throw new GeminiError(`Gemini network error: ${e.message}`, { status: 502 });
  }

  if (!res.ok) {
    // Đọc body ĐÚNG 1 LẦN rồi giao cho buildHttpError (429/403-quota -> Gemini429Error, còn lại GeminiError).
    let text = '';
    try {
      text = await res.text();
    } catch (e) {
      if (timedOut || e.name === 'AbortError') {
        clearTimeout(timer);
        throw new GeminiError(`Gemini stream timeout after ${timeoutMs}ms`, { status: 504 });
      }
      logger.warn(`Cannot read error body (HTTP ${res.status}): ${e.message}`);
    }
    clearTimeout(timer);
    throw buildHttpError(res.status, text);
  }

  // KHÔNG gán res.body (Response.body của undici chỉ có getter -> gán bị bỏ qua im lặng).
  // Trả object mới bọc stream, reset idle timeout mỗi chunk.
  const reader = res.body.getReader();
  const resetIdle = () => {
    if (timedOut) return;
    clearTimeout(timer);
    timer = setTimeout(onTimeout, timeoutMs);
  };
  const wrapped = new ReadableStream({
    async pull(ctrl) {
      try {
        const { done, value } = await reader.read();
        if (done) { clearTimeout(timer); ctrl.close(); return; }
        resetIdle();
        ctrl.enqueue(value);
      } catch (err) {
        clearTimeout(timer);
        ctrl.error(timedOut ? new GeminiError(`Gemini stream idle timeout after ${timeoutMs}ms`, { status: 504 }) : err);
      }
    },
    cancel(reason) {
      clearTimeout(timer);
      controller.abort();
      return reader.cancel(reason).catch(() => {});
    },
  });
  return { ok: res.ok, status: res.status, headers: res.headers, body: wrapped };
}

module.exports = { callGemini, callGeminiStream, Gemini429Error, GeminiError };
