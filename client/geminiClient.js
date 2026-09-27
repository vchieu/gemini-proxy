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
  let res;
  try {
    res = await fetch(buildUrl(model, key.api_key, false), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiRequestBody),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new GeminiError(`Gemini request timeout after ${timeoutMs}ms`, { status: 504 });
    throw new GeminiError(`Gemini network error: ${e.message}`, { status: 502 });
  }
  clearTimeout(timer);

  let body;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : {};
  } catch (_) {
    body = { raw: text };
  }

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
    const msg = body?.error?.message || text || `HTTP ${res.status}`;
    const err = new GeminiError(`Gemini error ${res.status}: ${msg}`, { status: res.status, body });
    err.rawBody = body;
    throw err;
  }
  return body;
}

/**
 * Gọi Gemini streaming (SSE). Trả về Response để caller pipe về client.
 * Timeout cover CẢ stream body (idle timeout): nếu không nhận được data
 * trong timeoutMs thì abort — tránh treo vô hạn nếu upstream im lặng.
 */
async function callGeminiStream(key, model, geminiRequestBody, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
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
  // Giữ timer cho tới khi stream body đọc xong — reset mỗi khi có data
  const resetIdleTimeout = () => {
    if (timedOut) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  // Patch body stream để reset idle timeout mỗi khi có chunk
  if (res.ok && res.body) {
    const originalBody = res.body;
    if (typeof originalBody.pipe === 'function') {
      // Node Readable — wrap qua PassThrough để reset timer
      const { PassThrough } = require('stream');
      const pt = new PassThrough();
      originalBody.on('data', () => resetIdleTimeout());
      originalBody.pipe(pt);
      res.body = pt;
    } else if (typeof originalBody.getReader === 'function') {
      // fetch ReadableStream (browser-style) — wrap iterator
      const reader = originalBody.getReader();
      const self = res;
      const wrapped = {
        getReader() {
          return {
            read() {
              return reader.read().then((result) => {
                if (!result.done) resetIdleTimeout();
                return result;
              });
            },
            cancel(reason) {
              return reader.cancel(reason);
            },
            releaseLock() {
              reader.releaseLock();
            },
          };
        },
      };
      res.body = wrapped;
    }
  }

  if (res.status === 429) {
    clearTimeout(timer);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch (_) { body = { error: { message: text } }; }
    const msg = body?.error?.message || text;
    throw new Gemini429Error(msg, {
      rawMessage: msg,
      details: body?.error?.details,
      retryDelaySeconds: extractRetryDelaySeconds(body),
      status: 429,
    });
  }
  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text();
    throw new GeminiError(`Gemini error ${res.status}: ${text}`, { status: res.status });
  }
  // Khi stream kết thúc, dọn dẹp timer
  if (res.body && typeof res.body.on === 'function') {
    res.body.on('end', () => clearTimeout(timer));
    res.body.on('close', () => clearTimeout(timer));
  } else if (res.body && typeof res.body.getReader === 'function') {
    // Đã wrap — reader gốc sẽ tự kết thúc; clearTimeout qua patch ở trên
    const cleanup = () => clearTimeout(timer);
    res.body.getReader().closed.then(cleanup, cleanup);
  }
  return res;
}

module.exports = { callGemini, callGeminiStream, Gemini429Error, GeminiError };
