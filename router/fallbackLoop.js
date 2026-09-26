const { selectAndReserve } = require('./selector');
const { extractRetryDelaySeconds, DEFAULT_COOLDOWN_SECONDS } = require('../client/errorParser');
const { Gemini429Error } = require('../client/geminiClient');
const { estimateTokens } = require('../utils/tokenEstimate');
const { openAiToGemini, geminiToOpenAi } = require('../api/translate');
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

/**
 * Điều phối toàn bộ vòng đời 1 request: chọn cặp -> gọi Gemini -> nếu 429 thì
 * setCooldown + chọn cặp khác -> lặp tới khi thành công hoặc hết max_fallback_attempts.
 * @param {object} agentRequest  // request format OpenAI (messages, model, ...)
 * @param {{models, keys, stateStore, geminiClient, config}} deps
 * @returns {Promise<object>}    // { openAiResponse, usedKeyId, usedModel, attempts }
 */
async function handleRequest(agentRequest, { models, keys, stateStore, geminiClient, config }) {
  const maxAttempts = (config && config.max_fallback_attempts) || 12;
  const defaultCooldown = (config && config.default_cooldown_seconds) || DEFAULT_COOLDOWN_SECONDS;
  const timeoutMs = (config && config.request_timeout_ms) || 60000;

  // Giới hạn model theo yêu cầu agent nếu respect_agent_model=true và model cụ thể tồn tại
  let candidateModels = models;
  const requestedModel = agentRequest && agentRequest.model;
  if (config && config.respect_agent_model && requestedModel && requestedModel !== 'auto') {
    const found = models.filter((m) => m.name === requestedModel);
    if (found.length > 0) candidateModels = found;
  }

  const estimated = estimateTokens(agentRequest && agentRequest.messages ? agentRequest.messages : agentRequest);
  const geminiBody = openAiToGemini(agentRequest || {});

  // Edge case: request cần token quá lớn, vượt TPM của mọi model -> lỗi rõ ràng
  const maxTpm = Math.max(...candidateModels.map((m) => m.limits.tpm));
  if (estimated > maxTpm) {
    throw new Aggregated429Error(
      `Request ước lượng ~${estimated} tokens, vượt TPM tối đa (${maxTpm}) của mọi model. Hãy giảm độ dài prompt.`,
      defaultCooldown
    );
  }

  const triedPairs = [];
  let attempts = 0;

  while (attempts < maxAttempts) {
    const now = Date.now();
    // select + reserve là 1 khối đồng bộ (không await ở giữa) nên các request
    // đồng thời không thể cùng giữ 1 slot (edge case #3).
    const pair = selectAndReserve(candidateModels, keys, stateStore, now, estimated, triedPairs);
    if (!pair) {
      const waitMs = minCooldownRemainingMs(candidateModels, keys, stateStore, now);
      const retryAfter = Math.max(1, Math.ceil(waitMs / 1000));
      logger.warn('All pairs exhausted', { tried: triedPairs.length, retryAfter });
      throw new Aggregated429Error(
        'Tất cả model/key đều đang bị giới hạn, vui lòng thử lại sau',
        retryAfter
      );
    }

    logger.info(`Attempt ${attempts + 1}: trying key=${pair.key.id} model=${pair.model.name}`);
    try {
      const geminiRes = await geminiClient.callGemini(pair.key, pair.model, geminiBody, { timeoutMs });
      const usage = geminiRes.usageMetadata || {};
      const totalTokens = usage.totalTokenCount || estimated;
      stateStore.release(pair.key.id, pair.model.name, estimated);
      stateStore.recordSuccess(pair.key.id, pair.model.name, totalTokens);
      const openAiResponse = geminiToOpenAi(geminiRes, pair.model.name);
      logger.info(`Success with key=${pair.key.id} model=${pair.model.name}`, { tokens: totalTokens });
      return { openAiResponse, usedKeyId: pair.key.id, usedModel: pair.model.name, attempts: attempts + 1 };
    } catch (e) {
      if (e instanceof Gemini429Error || e.name === 'Gemini429Error' || e.status === 429) {
        let retrySeconds = e.retryDelaySeconds;
        if (!Number.isFinite(retrySeconds) || retrySeconds <= 0) {
          retrySeconds = extractRetryDelaySeconds({ error: { message: e.rawMessage || e.message, details: e.details } });
          if (!Number.isFinite(retrySeconds) || retrySeconds <= 0) retrySeconds = defaultCooldown;
        }
        // cộng buffer nhỏ 0.5s để tránh gọi lại đúng biên
        const unblockAt = Date.now() + Math.ceil(retrySeconds * 1000) + 500;
        stateStore.release(pair.key.id, pair.model.name, estimated);
        stateStore.setCooldown(pair.key.id, pair.model.name, unblockAt);
        logger.warn(`429 from key=${pair.key.id} model=${pair.model.name}, cooldown ${retrySeconds}s`, { msg: e.message });
        triedPairs.push(pair);
        attempts += 1;
        continue;
      }
      // lỗi khác 429 (network, 500...): trả chỗ, trả lỗi ngay, không tính quota
      stateStore.release(pair.key.id, pair.model.name, estimated);
      logger.error(`Non-429 error from key=${pair.key.id} model=${pair.model.name}: ${e.message}`);
      throw e;
    }
  }

  throw new Aggregated429Error('Đã thử hết số lần fallback cho phép', defaultCooldown);
}

module.exports = { handleRequest, Aggregated429Error };
