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

const OPENAI_COMPAT_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

// Field phải xoá khỏi body trước khi forward tới endpoint OpenAI-compat của Google.
// Kết quả Phase 0 (spike Q6): mặc định rỗng – nếu spike chứng minh field nào bị từ chối
// mới thêm vào whitelist này.
const OPENAI_DROP_FIELDS = [];

const QUOTA_RE = /quota|rate|limit|retry/i;

function buildUrl(model, apiKey, stream) {
  const action = stream ? 'streamGenerateContent' : 'generateContent';
  return (
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.name)}` +
    `:${action}?key=${encodeURIComponent(apiKey)}` +
    (stream ? '&alt=sse' : '')
  );
}

/**
 * Endpoint OpenAI-compat của Google — CÙNG 1 URL cho stream/không stream,
 * Google phân biệt qua field `stream` trong body (khác với Gemini-native
 * phân biệt qua `:streamGenerateContent`).
 * Auth gửi qua header `Authorization: Bearer <key>` (set ở callOpenAI/callOpenAIStream),
 * KHÔNG nhét key vào query string.
 * @param {ApiKeyConfig} key
 * @param {boolean} stream
 * @returns {string}
 */
function buildOpenAiUrl(key, stream) {
  return OPENAI_COMPAT_URL;
}

/**
 * Dựng lỗi từ 1 HTTP response KHÔNG ok, dựa trên `text` ĐÃ ĐỌC (body chỉ được
 * đọc đúng 1 lần ở caller — đọc lần 2 trên Response sẽ ném TypeError "Body is unusable").
 * - 429, hoặc 403 kèm message quota/rate/limit/retry -> Gemini429Error (có retryDelaySeconds)
 * - còn lại -> GeminiError `Gemini error <status>: <text>` (prefix này được
 *   fallbackLoop.isTransientUpstream dùng để nhận diện 5xx upstream) + `.body` là
 *   JSON Google đã parse (undefined nếu body không phải JSON object).
 * Q3 fix: nếu body JSON là mảng `[{error:{...}}]` → bóc phần tử đầu làm parsed.
 * @param {number} status
 * @param {string} text
 * @returns {Gemini429Error | GeminiError}
 */
function buildHttpError(status, text) {
  let parsed;
  try { parsed = text ? JSON.parse(text) : undefined; } catch (_) { parsed = undefined; }
  // Q3: nếu parsed là mảng, lấy phần tử đầu có thuộc tính error
  if (Array.isArray(parsed)) {
    const first = parsed[0];
    if (first && first.error && typeof first.error === 'object') {
      parsed = first;
    }
  }
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
 * Gọi OpenAI-compatible endpoint: POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
 * @param {ApiKeyConfig} key
 * @param {ModelConfig} model
 * @param {object} openAiBody  // format OpenAI chat-completions (messages, tools, ...)
 * @param {{timeoutMs?: number}} options
 * @returns {Promise<object>}  // JSON đã parse từ response
 * @throws {Gemini429Error} khi bị rate limit
 * @throws {GeminiError} lỗi HTTP khác
 */
async function callOpenAI(key, model, openAiBody, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res, text;
  try {
    const body = buildOpenAiBody(openAiBody, model, false);
    res = await fetch(buildOpenAiUrl(key, false), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key.api_key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    text = await res.text(); // đọc body ĐÚNG 1 LẦN; timeout phủ cả lúc đọc body
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
 * Gọi OpenAI-compatible streaming endpoint.
 * Trả về object mới { ok, status, headers, body } bọc ReadableStream, KHÔNG gán res.body.
 * @param {ApiKeyConfig} key
 * @param {ModelConfig} model
 * @param {object} openAiBody  // format OpenAI chat-completions
 * @param {{timeoutMs?: number}} options
 * @returns {Promise<{ ok: boolean, status: number, headers: object, body: ReadableStream }>}
 */
async function callOpenAIStream(key, model, openAiBody, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  const controller = new AbortController();
  let timedOut = false;
  const onTimeout = () => { timedOut = true; controller.abort(); };
  let timer = setTimeout(onTimeout, timeoutMs);

  let res;
  try {
    const body = buildOpenAiBody(openAiBody, model, true);
    res = await fetch(buildOpenAiUrl(key, true), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key.api_key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (timedOut || e.name === 'AbortError') throw new GeminiError(`Gemini stream timeout after ${timeoutMs}ms`, { status: 504 });
    throw new GeminiError(`Gemini network error: ${e.message}`, { status: 502 });
  }

  if (!res.ok) {
    // Đọc body ĐÚNG 1 LẦN rồi giao cho buildHttpError (Q3: hỗ trợ body mảng).
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

/**
 * Xoá các field không được phép gửi tới Google OpenAI-compat endpoint.
 * - Nếu `stream`=true → giữ `stream_options` (kèm `include_usage: true`), xoá field lạ
 * - Nếu `stream`=false → xoá `stream_options` hoàn toàn
 * @param {object} body
 * @param {ModelConfig} model
 * @param {boolean} stream
 * @returns {object}
 */
function buildOpenAiBody(body, model, stream) {
  const b = { ...body, model: model.name };
  for (const f of OPENAI_DROP_FIELDS) delete b[f];
  if (stream) {
    b.stream_options = { ...(body.stream_options || {}), include_usage: true };
  } else {
    delete b.stream_options;
  }
  return b;
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

module.exports = { callGemini, callGeminiStream, callOpenAI, callOpenAIStream, Gemini429Error, GeminiError, buildHttpError };
