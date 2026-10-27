const { selectAndReserve } = require('./selector');
const { cooldownUntilFor429, DEFAULT_COOLDOWN_SECONDS } = require('../client/errorParser');
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

// Timeout đợi byte đầu (connect + header + chunk SSE đầu) — mặc định của config
// `first_byte_timeout_ms`. Không đặt quá thấp: model có thinking + prompt dài của
// Cline/OpenCode có thể lâu mới ra chunk đầu.
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 20000;

// Model 5xx/timeout bị bỏ qua trong các request kế tiếp bấy lâu (circuit breaker
// trong RAM, xem StateStore.penalizeModel). 45s: đủ để model hồi phục sau spike
// mà request sau không mất 10-60s thử lại nó.
const MODEL_PENALTY_MS = 45000;

/**
 * HTTP 5xx THẬT từ upstream (Google trả !res.ok) — lỗi tạm thời, nên thử cặp khác.
 * Ngoài ra timeout do proxy tự sinh cũng là tạm thời: 504 kèm chữ "timeout"
 * (connect / first-byte / idle — `Gemini request timeout...`,
 * `Gemini stream first-byte timeout...`, `Gemini stream idle timeout...`) nghĩa là
 * model đó TREO, không phải key hỏng -> fallback sang model khác thay vì kẹp request
 * tới hết timeout rồi để agent retry lại đúng model treo (lệch plan §5.5 — ghi rõ
 * ở AGENTS.md §6.5).
 * Loại network của chính proxy ra khỏi nhóm này: message
 * "Gemini network error..." (status 502) không match -> vẫn trả ngay như plan §5.5.
 */
function isTransientUpstream(e) {
  if (!e) return false;
  if (e.status === 504 && typeof e.message === 'string' && /timeout/i.test(e.message)) return true;
  return TRANSIENT_UPSTREAM_STATUS.has(e.status)
    && typeof e.message === 'string'
    && e.message.startsWith('Gemini error ');
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
  // First-byte timeout (nguyên nhân 1 + 3: timeout không fallback, không có timeout
  // riêng cho byte đầu): thời gian đợi connect + header + chunk SSE đầu trước khi
  // coi model TREO và fallback. Kẹp bởi request_timeout_ms để không chờ byte đầu
  // lâu hơn chính timeout request.
  const firstByteMs = Math.min(
    (config && config.first_byte_timeout_ms) || DEFAULT_FIRST_BYTE_TIMEOUT_MS,
    timeoutMs
  );
  const mode = (config && config.upstream_mode) || 'openai_compat';

  let candidateModels = models;
  const requestedModel = agentRequest && agentRequest.model;
  if (config && config.respect_agent_model && requestedModel && requestedModel !== 'auto') {
    const found = models.filter((m) => m.name === requestedModel);
    if (found.length > 0) {
      candidateModels = found;
    } else {
      logger.warn(`Model "${requestedModel}" không có trong models.json -> xoay tất cả model (dùng "auto" hoặc thêm vào config)`);
    }
  }

  // Truyền cả body (không chỉ messages[]) để estimateTokens tính thêm JSON của `tools`
  // — truyền messages[] sẽ rơi vào nhánh mảng và bỏ sót tools schema (L2).
  const estimated = options.geminiBody
    ? estimateTokens(options.geminiBody)
    : estimateTokens(agentRequest);
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
  // Circuit breaker (nguyên nhân 2 — không có trí nhớ giữa các request): model bị
  // phạt từ request TRƯỚC (5xx/timeout) bị loại ngay khỏi danh sách thử của request
  // này -> request sau vào thẳng model tốt thay vì mất 10-60s thử lại model đang treo.
  // Nếu model sắp hết hạn phạt thì gỡ ra và thử lại 1 lần (xem nhánh `!pair` dưới).
  const skipped = [];
  const now0 = Date.now();
  const penalizedModels = candidateModels.filter((m) => stateStore.isModelPenalized(m.name, now0));
  if (penalizedModels.length > 0 && penalizedModels.length < candidateModels.length) {
    for (const m of penalizedModels) {
      for (const k of keys) {
        if (k.enabled === false) continue;
        const p = { key: k, model: m };
        triedPairs.push(p);
        skipped.push(p);
      }
    }
    logger.info(`Bỏ qua ${penalizedModels.length} model đang bị phạt (${MODEL_PENALTY_MS / 1000}s): ${penalizedModels.map((m) => m.name).join(', ')}`);
  }
  let attempts = 0;
  let lastTransient = null; // lỗi 5xx upstream gần nhất (nếu có)

  while (attempts < maxAttempts) {
    const now = Date.now();
    // select + reserve đồng bộ, không await ở giữa (edge case #3)
    const pair = selectAndReserve(candidateModels, keys, stateStore, now, estimated, triedPairs, config && config.strategy);
    if (!pair) {
      if (skipped.length > 0) {
        // Không còn cặp khả dụng trong khi các model bị phạt vẫn đang bị loại -> gỡ
        // các cặp đó khỏi triedPairs và thử lại ĐÚNG 1 lần (skipped được làm rỗng
        // ngay đây nên không thể lặp vô hạn). Nhờ vậy: model hết hạn phạt được
        // thử lại ngay, và mọi model đều bị phạt thì không model nào bị loại
        // (tránh tự khóa chính mình).
        const skipSet = new Set(skipped);
        for (let i = triedPairs.length - 1; i >= 0; i--) {
          if (skipSet.has(triedPairs[i])) triedPairs.splice(i, 1);
        }
        skipped.length = 0;
        continue;
      }
      if (lastTransient) {
        // Có lỗi 5xx upstream trong đợt thử này -> trả lỗi 5xx gốc thay vì mask thành 429
        logger.warn(`All pairs failed with transient upstream 5xx: ${lastTransient.message}`);
        throw lastTransient;
      }
      const waitMs = minCooldownRemainingMs(candidateModels, keys, stateStore, now);
      const retryAfter = Math.max(1, Math.ceil(waitMs / 1000));
      logger.warn('All pairs exhausted', { tried: triedPairs.length, retryAfter });
      throw new Aggregated429Error('Tất cả model/key đều đang bị giới hạn, vui lòng thử lại sau', retryAfter);
    }

    logger.info(`Attempt ${attempts + 1}: trying key=${pair.key.id} model=${pair.model.name}`);
    try {
      const ctx = { geminiBody, estimated, timeoutMs, firstByteMs, signal: options.signal };
      // Case B (xem api/signatureShim.js): dựng lại extra_content từ callsig_… trong id
      // trước khi gửi lên Google, nếu không replay history sẽ bị 400 missing signature.
      if (mode === 'openai_compat') ctx.openAiBody = signatureShim.requestToUpstream(agentRequest);
      const value = await call(pair, ctx);
      // Model này chạy tốt -> gỡ phạt (nếu có) để các request sau được chọn lại nó
      stateStore.clearModelPenalty(pair.model.name);
      return { value, pair, estimated, attempts: attempts + 1 };
    } catch (e) {
      stateStore.release(pair.key.id, pair.model.name, estimated);
      if (is429(e)) {
        // Tính cooldown qua helper dùng chung (M2/M3): quota theo NGÀY không có
        // retryDelay tường minh -> cooldown tới nửa đêm PT thay vì 30s.
        const pairState = stateStore.get(pair.key.id, pair.model.name);
        const cooldownUntil = cooldownUntilFor429(
          { error: { message: e.rawMessage || e.message, details: e.details } },
          {
            defaultCooldownSeconds: defaultCooldown,
            retryDelaySecondsHint: e.retryDelaySeconds,
            dailyResetAt: pairState.daily_reset_at,
          }
        );
        stateStore.setCooldown(pair.key.id, pair.model.name, cooldownUntil);
        logger.warn(`429 from key=${pair.key.id} model=${pair.model.name}, cooldown tới ${new Date(cooldownUntil).toISOString()}`, { msg: e.message });
        triedPairs.push(pair);
        attempts += 1;
        continue;
      }
      if (e.status === 499) {
        // Client đã ngắt kết nối giữa chừng -> không phải lỗi upstream, không log error
        logger.info(`Client disconnected, aborted upstream call key=${pair.key.id} model=${pair.model.name}`);
        throw e;
      }
      if (isTransientUpstream(e)) {
        // Lệch plan §5.5 (ghi rõ ở AGENTS.md §6.5): 5xx upstream VÀ timeout của
        // proxy là lỗi tạm thời của model (overload/spikes/treo) -> fallback sang
        // cặp khác NGAY, không tính quota, không set cooldown. Lỗi theo model ->
        // loại hết key của model này trong request này + phạt model 45s (circuit
        // breaker) để các request KẾ TIẾP không thử lại model vừa treo.
        logger.warn(`HTTP ${e.status} from key=${pair.key.id} model=${pair.model.name} (transient), thử cặp khác`, { msg: e.message });
        for (const k of keys) if (k.enabled !== false) triedPairs.push({ key: k, model: pair.model });
        stateStore.penalizeModel(pair.model.name, MODEL_PENALTY_MS);
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

/** Non-stream. Contract không đổi (tham số `options` thêm optional, backward-compatible). */
async function handleRequest(agentRequest, deps, options = {}) {
  const { geminiClient, stateStore } = deps;
  const { value: geminiRes, pair, estimated, attempts } = await withFallback(
    agentRequest, deps,
    (p, ctx) => {
      // Sử ctx.openAiBody nếu có (mode openai_compat), ngược lại dùng geminiBody
      const body = ctx.openAiBody || ctx.geminiBody;
      if (ctx.openAiBody) return geminiClient.callOpenAI(p.key, p.model, body, { timeoutMs: ctx.timeoutMs, signal: ctx.signal });
      return geminiClient.callGemini(p.key, p.model, body, { timeoutMs: ctx.timeoutMs, signal: ctx.signal });
    },
    { signal: options.signal }
  );
  const upstreamMode = (deps && deps.config && deps.config.upstream_mode) || 'openai_compat';
  // Cả 2 mode đều fallback về `estimated` khi upstream KHÔNG trả usage — nếu không,
  // recordSuccess ghi 0 token và TPM bị đếm thiếu (đọc từ review).
  let released = false;
  try {
    const totalTokens = upstreamMode === 'openai_compat'
      ? ((geminiRes && geminiRes.usage && geminiRes.usage.total_tokens) || estimated)
      : (((geminiRes && geminiRes.usageMetadata) || {}).totalTokenCount || estimated);
    // release -> recordSuccess đồng bộ, không await ở giữa
    stateStore.release(pair.key.id, pair.model.name, estimated);
    released = true;
    stateStore.recordSuccess(pair.key.id, pair.model.name, totalTokens);
    const openAiResponse = upstreamMode === 'openai_compat'
      ? signatureShim.responseToClient(geminiRes)
      : geminiToOpenAi(geminiRes, pair.model.name);
    logger.info(`Success with key=${pair.key.id} model=${pair.model.name}`, { tokens: totalTokens });
    return { openAiResponse, usedKeyId: pair.key.id, usedModel: pair.model.name, attempts };
  } finally {
    if (!released) {
      stateStore.release(pair.key.id, pair.model.name, estimated);
    }
  }
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
      if (ctx.openAiBody) return geminiClient.callOpenAIStream(p.key, p.model, body, { timeoutMs: ctx.timeoutMs, firstByteMs: ctx.firstByteMs });
      return geminiClient.callGeminiStream(p.key, p.model, body, { timeoutMs: ctx.timeoutMs, firstByteMs: ctx.firstByteMs });
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
async function handleNativeRequest(requestedModel, geminiBody, deps, options = {}) {
  const { geminiClient, stateStore } = deps;
  const { value, pair, estimated, attempts } = await withFallback(
    { model: requestedModel }, deps,
    (p, ctx) => geminiClient.callGemini(p.key, p.model, ctx.geminiBody, { timeoutMs: ctx.timeoutMs, signal: ctx.signal }),
    { geminiBody, signal: options.signal }
  );
  let released = false;
  try {
    const total = ((value && value.usageMetadata) || {}).totalTokenCount || estimated;
    stateStore.release(pair.key.id, pair.model.name, estimated);
    released = true;
    stateStore.recordSuccess(pair.key.id, pair.model.name, total);
    return { geminiResponse: value, usedKeyId: pair.key.id, usedModel: pair.model.name, attempts };
  } finally {
    if (!released) {
      stateStore.release(pair.key.id, pair.model.name, estimated);
    }
  }
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
    (p, ctx) => geminiClient.callGeminiStream(p.key, p.model, ctx.geminiBody, { timeoutMs: ctx.timeoutMs, firstByteMs: ctx.firstByteMs }),
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
