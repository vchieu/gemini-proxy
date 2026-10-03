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

/**
 * Gọi Gemini generateContent API với 1 key + model cụ thể.
 * @param {ApiKeyConfig} key
 * @param {ModelConfig} model
 * @param {object} geminiRequestBody  // đã ở format Gemini (contents, generationConfig)
 * @param {{timeoutMs?: number}} options
 * @returns {Promise<object>}  // response Gemini gốc, có usageMetadata
 * @throws {Gemini429Error} khi bị rate limit — error object cần có `.rawMessage` và `.details`
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
    text = await res.text(); // timeout phủ cả lúc đọc body (#5)
  } catch (e) {
    if (e.name === 'AbortError') throw new GeminiError(`Gemini request timeout after ${timeoutMs}ms`, { status: 504 });
    throw new GeminiError(`Gemini network error: ${e.message}`, { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  let body;
  try { body = text ? JSON.parse(text) : {}; } catch (_) { body = { raw: text }; }

  if (res.status === 429 || res.status === 403) {
    // Gemini đôi khi trả 403 kèm quota message — coi như 429 nếu có retry info
    const msg = body?.error?.message || text || `HTTP ${res.status}`;
    const retryDelaySeconds = extractRetryDelaySeconds(body?.error ? body : { error: { message: msg, details: body?.error?.details } });
    const isQuota = /quota|rate|limit|retry/i.test(msg);
    if (res.status === 429 || isQuota) {
      throw new Gemini429Error(msg, {
        rawMessage: msg,
        details: body?.error?.details,
        retryDelaySeconds,
        status: 429,
      });
    }
  }
  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch (_) { parsed = undefined; }
    throw new GeminiError(`Gemini error ${res.status}: ${text}`, { status: res.status, body: parsed });
  }
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

  if (res.status === 429 || res.status === 403) {
    clearTimeout(timer);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch (_) { body = { error: { message: text } }; }
    const msg = body?.error?.message || text;
    const isQuota = /quota|rate|limit|retry/i.test(msg);
    if (res.status === 429 || isQuota) {
      throw new Gemini429Error(msg, {
        rawMessage: msg,
        details: body?.error?.details,
        retryDelaySeconds: extractRetryDelaySeconds(body?.error ? body : { error: { message: msg, details: body?.error?.details } }),
        status: 429,
      });
    }
  }
  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text();
    throw new GeminiError(`Gemini error ${res.status}: ${text}`, { status: res.status });
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
