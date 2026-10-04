const { selectAndReserve } = require('./selector');
const { extractRetryDelaySeconds, DEFAULT_COOLDOWN_SECONDS } = require('../client/errorParser');
const { Gemini429Error } = require('../client/geminiClient');
const { estimateTokens } = require('../utils/tokenEstimate');
const { openAiToGemini, geminiToOpenAi } = require('../api/translate');
const signatureShim = require('../api/signatureShim');
const { logger } = require('../utils/logger');

class Aggregated429Error extends Error {
  constructor(message, retryAfterSeconds) {
    super(message);
    this.name = 'Aggregated429Error';
    this.status = 429;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function minCooldownRemainingMs(models, keys, stateStore, nowMs) {
  let min = Infinity;
  for (const m of models) {
    for (const k of keys) {
      if (k.enabled === false) continue;
      const st = stateStore.get(k.id, m.name);
      if (st.cooldown_until > nowMs) min = Math.min(min, st.cooldown_until - nowMs);
    }
  }
  return min === Infinity ? 0 : min;
}

function is429(e) {
  return e instanceof Gemini429Error || e.name === 'Gemini429Error' || e.status === 429;
}

const TRANSIENT_UPSTREAM_STATUS = new Set([500, 502, 503, 504]);

/**
 * HTTP 5xx THẬT từ upstream (Google trả !res.ok) — lỗi tạm thời, nên thử cặp khác.
 * Loại timeout/network của chính proxy ra khỏi nhóm này: geminiClient sinh message
 * "Gemini request timeout..." / "Gemini network error..." nên không match prefix
 * "Gemini error <status>:" (những lỗi đó vẫn trả ngay theo plan §5.5).
 */
function isTransientUpstream(e) {
  return !!e
    && TRANSIENT_UPSTREAM_STATUS.has(e.status)
    && typeof e.message === 'string'
    && e.message.startsWith('Gemini error ');
}

function retrySecondsOf(e, defaultCooldown) {
  let s = e.retryDelaySeconds;
  if (!Number.isFinite(s) || s <= 0) {
    s = extractRetryDelaySeconds({ error: { message: e.rawMessage || e.message, details: e.details } });
    if (!Number.isFinite(s) || s <= 0) s = defaultCooldown;
  }
  return s;
}

/**
 * Vòng lặp chọn cặp -> gọi `call(pair, ctx)` -> nếu 429 thì cooldown + thử cặp khác.
 * Khi `call` thành công, cặp VẪN ĐANG được giữ chỗ: caller phải release() đúng 1 lần.
 * Khi `call` ném lỗi, withFallback tự release.
 */
async function withFallback(agentRequest, { models, keys, stateStore, config }, call, options = {}) {
  const maxAttempts = (config && config.max_fallback_attempts) || 12;
  const defaultCooldown = (config && config.default_cooldown_seconds) || DEFAULT_COOLDOWN_SECONDS;
  const timeoutMs = (config && config.request_timeout_ms) || 60000;
  const mode = (config && config.upstream_mode) || 'openai_compat';

  let candidateModels = models;
  const requestedModel = agentRequest && agentRequest.model;
  if (config && config.respect_agent_model && requestedModel && requestedModel !== 'auto') {
    const found = models.filter((m) => m.name === requestedModel);
    if (found.length > 0) candidateModels = found;
  }

  const estimated = options.geminiBody
    ? estimateTokens(options.geminiBody)
    : estimateTokens(agentRequest && agentRequest.messages ? agentRequest.messages : agentRequest);
  const geminiBody = options.geminiBody
    || (mode === 'openai_compat' ? undefined : openAiToGemini(agentRequest || {}));

  const maxTpm = Math.max(...candidateModels.map((m) => m.limits.tpm));
  if (estimated > maxTpm) {
    throw new Aggregated429Error(
      `Request ước lượng ~${estimated} tokens, vượt TPM tối đa (${maxTpm}) của mọi model. Hãy giảm độ dài prompt.`,
      defaultCooldown
    );
  }

  const triedPairs = [];
  let attempts = 0;
  let lastTransient = null; // lỗi 5xx upstream gần nhất (nếu có)

  while (attempts < maxAttempts) {
    const now = Date.now();
    // select + reserve đồng bộ, không await ở giữa (edge case #3)
    const pair = selectAndReserve(candidateModels, keys, stateStore, now, estimated, triedPairs, config && config.strategy);
    if (!pair) {
      const waitMs = minCooldownRemainingMs(candidateModels, keys, stateStore, now);
      if (lastTransient && waitMs === 0) {
        // hết cặp là do đã thử tất cả và đều 5xx (không có cooldown 429 nào) -> trả lỗi 5xx gốc
        logger.warn(`All pairs failed with transient upstream 5xx: ${lastTransient.message}`);
        throw lastTransient;
      }
      const retryAfter = Math.max(1, Math.ceil(waitMs / 1000));
      logger.warn('All pairs exhausted', { tried: triedPairs.length, retryAfter });
      throw new Aggregated429Error('Tất cả model/key đều đang bị giới hạn, vui lòng thử lại sau', retryAfter);
    }

    logger.info(`Attempt ${attempts + 1}: trying key=${pair.key.id} model=${pair.model.name}`);
    try {
      const ctx = { geminiBody, estimated, timeoutMs };
      // Case B (xem api/signatureShim.js): dựng lại extra_content từ callsig_… trong id
      // trước khi gửi lên Google, nếu không replay history sẽ bị 400 missing signature.
      if (mode === 'openai_compat') ctx.openAiBody = signatureShim.requestToUpstream(agentRequest);
      const value = await call(pair, ctx);
      return { value, pair, estimated, attempts: attempts + 1 };
    } catch (e) {
      stateStore.release(pair.key.id, pair.model.name, estimated);
      if (is429(e)) {
        const retrySeconds = retrySecondsOf(e, defaultCooldown);
        stateStore.setCooldown(pair.key.id, pair.model.name, Date.now() + Math.ceil(retrySeconds * 1000) + 500);
        logger.warn(`429 from key=${pair.key.id} model=${pair.model.name}, cooldown ${retrySeconds}s`, { msg: e.message });
        triedPairs.push(pair);
        attempts += 1;
        continue;
      }
      if (isTransientUpstream(e)) {
        // Lệch plan §5.5 (ghi rõ ở AGENTS.md §6.5): 5xx upstream là lỗi tạm thời của
        // model (overload/spikes) -> fallback sang cặp khác NGAY, không tính quota,
        // không set cooldown. 5xx theo mình model -> loại hết key của model này trong request này.
        logger.warn(`HTTP ${e.status} from key=${pair.key.id} model=${pair.model.name} (transient), thử cặp khác`, { msg: e.message });
        for (const k of keys) if (k.enabled !== false) triedPairs.push({ key: k, model: pair.model });
        lastTransient = e;
        attempts += 1;
        continue;
      }
      logger.error(`Non-429 error from key=${pair.key.id} model=${pair.model.name}: ${e.message}`);
      throw e;
    }
  }
  throw new Aggregated429Error('Đã thử hết số lần fallback cho phép', defaultCooldown);
}

/** Non-stream. Contract không đổi. */
async function handleRequest(agentRequest, deps) {
  const { geminiClient, stateStore } = deps;
  const { value: geminiRes, pair, estimated, attempts } = await withFallback(
    agentRequest, deps,
    (p, ctx) => {
      // Sử ctx.openAiBody nếu có (mode openai_compat), ngược lại dùng geminiBody
      const body = ctx.openAiBody || ctx.geminiBody;
      if (ctx.openAiBody) return geminiClient.callOpenAI(p.key, p.model, body, { timeoutMs: ctx.timeoutMs });
      return geminiClient.callGemini(p.key, p.model, body, { timeoutMs: ctx.timeoutMs });
    }
  );
  const upstreamMode = (deps && deps.config && deps.config.upstream_mode) || 'openai_compat';
  const totalTokens = upstreamMode === 'openai_compat'
    ? geminiRes.usage && geminiRes.usage.total_tokens
    : (geminiRes.usageMetadata || {}).totalTokenCount || estimated;
  // release -> recordSuccess đồng bộ, không await ở giữa
  stateStore.release(pair.key.id, pair.model.name, estimated);
  stateStore.recordSuccess(pair.key.id, pair.model.name, totalTokens);
  const openAiResponse = upstreamMode === 'openai_compat'
    ? signatureShim.responseToClient(geminiRes)
    : geminiToOpenAi(geminiRes, pair.model.name);
  logger.info(`Success with key=${pair.key.id} model=${pair.model.name}`, { tokens: totalTokens });
  return { openAiResponse, usedKeyId: pair.key.id, usedModel: pair.model.name, attempts };
}

/**
 * Stream: fallback ở giai đoạn MỞ stream (trước byte đầu tiên).
 * @returns {Promise<{ upstream, pair, estimated, release: () => void }>}
 *  `release` idempotent — caller PHẢI gọi khi stream kết thúc (mọi nhánh).
 */
async function openStream(agentRequest, deps) {
  const { geminiClient, stateStore } = deps;
  const { value: upstream, pair, estimated } = await withFallback(
    agentRequest, deps,
    (p, ctx) => {
      // Sử ctx.openAiBody nếu có (mode openai_compat), ngược lại dùng geminiBody
      const body = ctx.openAiBody || ctx.geminiBody;
      if (ctx.openAiBody) return geminiClient.callOpenAIStream(p.key, p.model, body, { timeoutMs: ctx.timeoutMs });
      return geminiClient.callGeminiStream(p.key, p.model, body, { timeoutMs: ctx.timeoutMs });
    }
  );
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    stateStore.release(pair.key.id, pair.model.name, estimated);
  };
  return { upstream, pair, estimated, release };
}

/**
 * Non-stream native request (gemini-native endpoint).
 * Gọi vớiFallback truyền { geminiBody } trực tiếp từ req.body.
 * Trả kết quả geminiResponse, keyId, model name, attempts.
 */
async function handleNativeRequest(requestedModel, geminiBody, deps) {
  const { geminiClient, stateStore } = deps;
  const { value, pair, estimated, attempts } = await withFallback(
    { model: requestedModel }, deps,
    (p, ctx) => geminiClient.callGemini(p.key, p.model, ctx.geminiBody, { timeoutMs: ctx.timeoutMs }),
    { geminiBody }
  );
  const total = (value.usageMetadata || {}).totalTokenCount || estimated;
  stateStore.release(pair.key.id, pair.model.name, estimated);
  stateStore.recordSuccess(pair.key.id, pair.model.name, total);
  return { geminiResponse: value, usedKeyId: pair.key.id, usedModel: pair.model.name, attempts };
}

/**
 * Stream native (gemini-native endpoint).
 * Mở stream qua withFallback, trả { upstream, pair, estimated, release }.
 * Caller (router) phải gọi release() mọi nhánh kết thúc.
 * @returns {Promise<{ upstream, pair, estimated, release: () => void }>}
 */
async function openNativeStream(requestedModel, geminiBody, deps) {
  const { geminiClient, stateStore } = deps;
  const { value: upstream, pair, estimated } = await withFallback(
    { model: requestedModel }, deps,
    (p, ctx) => geminiClient.callGeminiStream(p.key, p.model, ctx.geminiBody, { timeoutMs: ctx.timeoutMs }),
    { geminiBody }
  );
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    stateStore.release(pair.key.id, pair.model.name, estimated);
  };
  return { upstream, pair, estimated, release };
}

module.exports = { handleRequest, openStream, handleNativeRequest, openNativeStream, Aggregated429Error };
