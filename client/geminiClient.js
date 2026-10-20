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

// Endpoint OpenAI-compat của Google — CÙNG 1 URL cho stream/không stream,
// Google phân biệt qua field `stream` trong body (khác với Gemini-native
// phân biệt qua `:streamGenerateContent`). Auth gửi qua header
// `Authorization: Bearer <key>` (set ở callOpenAI/callOpenAIStream),
// KHÔNG nhét key vào query string.
const OPENAI_COMPAT_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

// Field phải xoá khỏi body trước khi forward tới endpoint OpenAI-compat của Google.
// Kết quả Phase 6 live test (spike Q6 — xem docs/openai-compat-spike.md): mặc định
// rỗng, vì chưa phát hiện field nào bị Google từ chối.
const OPENAI_DROP_FIELDS = [];

// Nhận diện429 quota (kể cả 403 "quota" — Gemini đôi khi trả 403 khi hết quota).
// ⚠ M1: KHÔNG được dùng裸 `rate`/`limit` — "generateContent" chứa chuỗi "rate",
// và nhiều403 THẬT của Google ("...GenerateContent are blocked",
// "Cloud API has not been used in project...") từng bị nhầm thành 429 -> cooldown
// 30s vô lý + fallback + trả về aggregated 429 thay vì403 gốc cho client.
const QUOTA_RE = /quota|\brate[- _]?limit|resource[_ ]exhausted|retry in/i;

function buildUrl(model, apiKey, stream) {
  const action = stream ? 'streamGenerateContent' : 'generateContent';
  return (
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.name)}` +
    `:${action}?key=${encodeURIComponent(apiKey)}` +
    (stream ? '&alt=sse' : '')
  );
}

/**
 * Nối signal của client (nếu có) vào AbortController nội bộ: client ngắt kết nối
 * giữa chừng (non-stream) -> huỷ luôn upstream request thay vì giữ reservation
 * tới khi timeout 60s. Lỗi phân biệt được với timeout nhờ `options.signal.aborted`
 * (ném GeminiError status 499 — non-429/non-5xx -> withFallback trả ngay, không
 * tính quota, không set cooldown).
 * @param {AbortController} controller
 * @param {AbortSignal} [externalSignal]
 * @returns {() => void} detach — gỡ listener (gọi trong finally)
 */
function attachExternalAbort(controller, externalSignal) {
  if (!externalSignal) return () => {};
  const onAbort = () => controller.abort();
  if (externalSignal.aborted) controller.abort();
  else externalSignal.addEventListener('abort', onAbort, { once: true });
  return () => externalSignal.removeEventListener('abort', onAbort);
}

/** Lỗi đúng chuẩn khi upstream bị huỷ do client ngắt (status 499). */
function clientAbortedError() {
  return new GeminiError('Upstream request aborted (client disconnected)', { status: 499 });
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
 * @param {{timeoutMs?: number, signal?: AbortSignal}} options  // signal: client ngắt -> huỷ upstream (499)
 * @returns {Promise<object>}  // response Gemini gốc, có usageMetadata
 * @throws {Gemini429Error} khi bị rate limit — error object cần có `.rawMessage` và `.details`
 * @throws {GeminiError} lỗi HTTP khác (`.status`, `.body` = JSON Google nếu parse được)
 */
async function callGemini(key, model, geminiRequestBody, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const detachAbort = attachExternalAbort(controller, options.signal);
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
    if (e.name === 'AbortError') {
      if (options.signal && options.signal.aborted) throw clientAbortedError();
      throw new GeminiError(`Gemini request timeout after ${timeoutMs}ms`, { status: 504 });
    }
    throw new GeminiError(`Gemini network error: ${e.message}`, { status: 502 });
  } finally {
    clearTimeout(timer);
    detachAbort();
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
 * @param {{timeoutMs?: number, signal?: AbortSignal}} options  // signal: client ngắt -> huỷ upstream (499)
 * @returns {Promise<object>}  // JSON đã parse từ response
 * @throws {Gemini429Error} khi bị rate limit
 * @throws {GeminiError} lỗi HTTP khác
 */
async function callOpenAI(key, model, openAiBody, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const detachAbort = attachExternalAbort(controller, options.signal);
  let res, text;
  try {
    const body = buildOpenAiBody(openAiBody, model, false);
    res = await fetch(OPENAI_COMPAT_URL, {
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
    if (e.name === 'AbortError') {
      if (options.signal && options.signal.aborted) throw clientAbortedError();
      throw new GeminiError(`Gemini request timeout after ${timeoutMs}ms`, { status: 504 });
    }
    throw new GeminiError(`Gemini network error: ${e.message}`, { status: 502 });
  } finally {
    clearTimeout(timer);
    detachAbort();
  }

  if (!res.ok) throw buildHttpError(res.status, text);

  let body;
  try { body = text ? JSON.parse(text) : {}; } catch (_) { body = { raw: text }; }
  return body;
}

/**
 * Core dùng chung cho CẢ HAI hàm stream (`callGeminiStream` / `callOpenAIStream`) —
 * 2 hàm này chỉ khác nhau ở URL + header + body, toàn bộ phần timeout/wrap stream
 * giống hệt nhau (trước đây bị copy-paste ~50 dòng).
 *
 * - `firstByteMs` (mặc định = `timeoutMs`): phủ connect + header + **chunk SSE đầu
 *   tiên**. Hàm ĐỌC TRƯỚC chunk đầu trước khi trả về, nên upstream treo trước byte
 *   đầu thì ném lỗi NGAY tại đây — `openStream` chưa trả pair -> `withFallback`
 *   kịp fallback sang model khác. (Trước đây trả về ngay khi có header, tới khi
 *   chunk đầu không tới thì đã quá muộn để fallback: request treo hết timeout rồi
 *   chết, agent retry lại đúng model đang treo.)
 * - `timeoutMs`: idle timeout tính từ sau chunk đầu, reset mỗi chunk (giữ nguyên),
 *   áp dụng cả lúc đọc body lỗi.
 * - Đọc body lỗi ĐÚNG 1 LẦN rồi giao cho `buildHttpError` (Q3: hỗ trợ body mảng).
 * - Trả object MỚI bọc ReadableStream — KHÔNG gán `res.body`
 *   (Response.body của undici chỉ có getter -> gán bị bỏ qua im lặng).
 *
 * @param {(signal: AbortSignal) => Promise<Response>} doFetch
 * @param {number} timeoutMs  // idle timeout sau chunk đầu tiên
 * @param {number} [firstByteMs]  // timeout connect + header + chunk đầu (mặc định = timeoutMs)
 * @returns {Promise<{ ok: boolean, status: number, headers: object, body: ReadableStream }>}
 */
async function fetchSse(doFetch, timeoutMs, firstByteMs) {
  const fbMs = Number(firstByteMs) > 0 ? Number(firstByteMs) : timeoutMs;
  const controller = new AbortController();
  let timedOut = false;
  let phase = 'first-byte'; // đổi sang 'idle' sau khi đã đọc được chunk đầu tiên
  const onTimeout = () => { timedOut = true; controller.abort(); };
  let timer = setTimeout(onTimeout, fbMs);
  const timeoutError = () => new GeminiError(
    phase === 'first-byte'
      ? `Gemini stream first-byte timeout after ${fbMs}ms`
      : `Gemini stream idle timeout after ${timeoutMs}ms`,
    { status: 504 }
  );

  let res;
  try {
    res = await doFetch(controller.signal);
  } catch (e) {
    clearTimeout(timer);
    if (timedOut || e.name === 'AbortError') throw timeoutError();
    throw new GeminiError(`Gemini network error: ${e.message}`, { status: 502 });
  }

  if (!res.ok) {
    if (timedOut) { clearTimeout(timer); throw timeoutError(); }
    let text = '';
    try {
      text = await res.text();
    } catch (e) {
      if (timedOut || e.name === 'AbortError') {
        clearTimeout(timer);
        throw timeoutError();
      }
      logger.warn(`Cannot read error body (HTTP ${res.status}): ${e.message}`);
    }
    clearTimeout(timer);
    throw buildHttpError(res.status, text);
  }

  if (timedOut) { clearTimeout(timer); throw timeoutError(); }

  // Đọc TRƯỚC chunk đầu dưới timer firstByteMs — điểm then chốt để kịp fallback:
  // nếu upstream treo ở đây thì lỗi ném ra TRƯỚC khi openStream trả pair.
  const reader = res.body.getReader();
  let first;
  try {
    first = await reader.read();
  } catch (e) {
    clearTimeout(timer);
    if (timedOut || e.name === 'AbortError') throw timeoutError();
    throw new GeminiError(`Gemini network error: ${e.message}`, { status: 502 });
  }
  clearTimeout(timer);
  phase = 'idle';
  timer = setTimeout(onTimeout, timeoutMs);

  const resetIdle = () => {
    if (timedOut) return;
    clearTimeout(timer);
    timer = setTimeout(onTimeout, timeoutMs);
  };
  let pendingFirst = first; // chunk đọc sẵn — trả lại ở lần pull đầu tiên
  const wrapped = new ReadableStream({
    async pull(ctrl) {
      try {
        const { done, value } = pendingFirst || await reader.read();
        pendingFirst = null;
        if (done) { clearTimeout(timer); ctrl.close(); return; }
        resetIdle();
        ctrl.enqueue(value);
      } catch (err) {
        clearTimeout(timer);
        ctrl.error(timedOut ? timeoutError() : err);
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
 * Gọi OpenAI-compatible streaming endpoint.
 * Trả về object mới { ok, status, headers, body } bọc ReadableStream, KHÔNG gán res.body.
 * @param {ApiKeyConfig} key
 * @param {ModelConfig} model
 * @param {object} openAiBody  // format OpenAI chat-completions
 * @param {{timeoutMs?: number, firstByteMs?: number}} options
 *   firstByteMs: thời gian đợi connect + header + chunk SSE đầu (mặc định = timeoutMs)
 * @returns {Promise<{ ok: boolean, status: number, headers: object, body: ReadableStream }>}
 */
async function callOpenAIStream(key, model, openAiBody, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  const body = buildOpenAiBody(openAiBody, model, true);
  return fetchSse((signal) => fetch(OPENAI_COMPAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key.api_key}`,
    },
    body: JSON.stringify(body),
    signal,
  }), timeoutMs, options.firstByteMs);
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
 * Gọi Gemini streaming (SSE). Trả về object mới bọc stream — đọc sẵn chunk đầu
 * (first-byte timeout) rồi reset idle timeout mỗi chunk.
 * KHÔNG trả Response gốc vì Response.body của undici chỉ có getter -> gán bị bỏ qua im lặng.
 * @param {{timeoutMs?: number, firstByteMs?: number}} options — firstByteMs: thời gian
 *   đợi connect + header + chunk SSE đầu (mặc định = timeoutMs)
 * @returns {Promise<{ ok: boolean, status: number, headers: object, body: ReadableStream }>}
 */
async function callGeminiStream(key, model, geminiRequestBody, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  return fetchSse((signal) => fetch(buildUrl(model, key.api_key, true), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(geminiRequestBody),
    signal,
  }), timeoutMs, options.firstByteMs);
}

module.exports = { callGemini, callGeminiStream, callOpenAI, callOpenAIStream, Gemini429Error, GeminiError, buildHttpError };
