const DEFAULT_COOLDOWN_SECONDS = 30;

// Google hay diễn tả quota theo NGÀY bằng chuỗi "PerDay" / "per day" / "per_day"
// (vd: "... limit 'GenerateContent requests per day' ..."). Dùng cho M3: 429 quota
// ngày không kèm retryDelay -> cooldown tới nửa đêm PT thay vì retry mỗi 30s trong ngày.
const DAILY_QUOTA_RE = /per[-_ ]?day/i;

function parseDurationToSeconds(str) {
  if (str == null) return null;
  const s = String(str).trim();
  // "23s", "23.7s", "1500ms", "2m", "1h"
  let m = /^([\d.]+)\s*ms$/i.exec(s);
  if (m) return parseFloat(m[1]) / 1000;
  m = /^([\d.]+)\s*h$/i.exec(s);
  if (m) return parseFloat(m[1]) * 3600;
  m = /^([\d.]+)\s*m$/i.exec(s);
  // chú ý: "ms" đã match trước nên đây là minutes
  if (m) return parseFloat(m[1]) * 60;
  m = /^([\d.]+)\s*s$/i.exec(s);
  if (m) return parseFloat(m[1]);
  m = /^([\d.]+)$/.exec(s);
  if (m) return parseFloat(m[1]);
  return null;
}

/**
 * Tìm thời gian retry Google gửi TƯỜNG MINH (RetryInfo details / retryDelay /
 * "retry in Xs" trong message). KHÔNG fallback về mặc định — khác với
 * `extractRetryDelaySeconds` (hàm đó luôn trả 30 khi không tìm thấy).
 * @param {object|string} errorResponseBody
 * @returns {number|null} số giây, null nếu KHÔNG tìm thấy
 */
function findExplicitRetryDelaySeconds(errorResponseBody) {
  try {
    if (errorResponseBody == null) return null;
    if (typeof errorResponseBody === 'string') {
      const m = /retry in ([\d.]+)s/i.exec(errorResponseBody);
      if (m) return parseFloat(m[1]);
      const d = parseDurationToSeconds(errorResponseBody);
      return d !== null && Number.isFinite(d) && d > 0 ? d : null;
    }

    const body = errorResponseBody;
    // Ưu tiên field structured: error.details[].retryDelay (RetryInfo)
    const details = body?.error?.details;
    if (Array.isArray(details)) {
      for (const d of details) {
        if (d && typeof d.retryDelay === 'string') {
          const v = parseDurationToSeconds(d.retryDelay);
          if (v !== null && Number.isFinite(v) && v > 0) return v;
        }
        // một số response lồng RetryInfo khác
        if (d && d['@type'] && /RetryInfo/i.test(d['@type']) && d.retryDelay) {
          const v = parseDurationToSeconds(d.retryDelay);
          if (v !== null && Number.isFinite(v) && v > 0) return v;
        }
      }
    }
    // top-level retryDelay
    if (typeof body.retryDelay === 'string') {
      const v = parseDurationToSeconds(body.retryDelay);
      if (v !== null && Number.isFinite(v) && v > 0) return v;
    }

    // Fallback: regex trên message text
    const candidates = [
      body?.error?.message,
      body?.message,
      body?.rawMessage,
    ];
    for (const text of candidates) {
      if (typeof text === 'string') {
        const m = /retry in ([\d.]+)s/i.exec(text);
        if (m) return parseFloat(m[1]);
      }
    }
    // thông điệp nằm sâu trong details message
    if (Array.isArray(details)) {
      for (const d of details) {
        if (d && typeof d.message === 'string') {
          const m = /retry in ([\d.]+)s/i.exec(d.message);
          if (m) return parseFloat(m[1]);
        }
      }
    }
  } catch (_) {
    // fallthrough
  }
  return null;
}

/**
 * @param {object|string} errorResponseBody  // body JSON trả về từ Gemini khi lỗi
 * @returns {number}  // số giây cần chờ trước khi retry (fallback DEFAULT_COOLDOWN_SECONDS)
 */
function extractRetryDelaySeconds(errorResponseBody) {
  try {
    const v = findExplicitRetryDelaySeconds(errorResponseBody);
    if (v !== null) return v;
  } catch (_) {
    // fallthrough
  }
  return DEFAULT_COOLDOWN_SECONDS;
}

/**
 * 429 này có phải quota theo NGÀY không (message/details nhắc "per day"/"PerDay")?
 * @param {object|string} bodyLike  shape { error: { message, details } } hoặc string
 * @returns {boolean}
 */
function mentionsDailyQuota(bodyLike) {
  try {
    const texts = [];
    if (typeof bodyLike === 'string') {
      texts.push(bodyLike);
    } else if (bodyLike && typeof bodyLike === 'object') {
      texts.push(bodyLike.error?.message, bodyLike.message, bodyLike.rawMessage);
      const details = bodyLike.error?.details;
      if (Array.isArray(details)) {
        for (const d of details) if (d && typeof d.message === 'string') texts.push(d.message);
      }
    }
    return texts.some((t) => typeof t === 'string' && DAILY_QUOTA_RE.test(t));
  } catch (_) {
    return false;
  }
}

/**
 * Tính thời điểm kết thúc cooldown (epoch ms) cho 1 lỗi 429 — dùng CHUNG ở
 * `router/fallbackLoop` (429 trước khi mở stream/response) và các nhánh lỗi
 * in-band mid-stream trong `api/*` (M2/M3).
 *
 * Ưu tiên: retryDelay Google gửi tường minh > `retryDelaySecondsHint` > default.
 * Ngoại lệ M3: nếu quota theo NGÀY (message/details nhắc "per day") và Google
 * KHÔNG gửi retryDelay tường minh -> cooldown tới `dailyResetAt` (nửa đêm PT),
 * thay vì retry vô ích mỗi 30s trong suốt ngày.
 *
 * @param {object|string} bodyLike  body Google gốc, shape { error: { message, details } }
 * @param {{ defaultCooldownSeconds?: number, dailyResetAt?: number, nowMs?: number, retryDelaySecondsHint?: number }} [opts]
 * @returns {number} epoch ms cooldown kết thúc
 */
function cooldownUntilFor429(bodyLike, opts = {}) {
  const now = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const def = Number.isFinite(opts.defaultCooldownSeconds) ? opts.defaultCooldownSeconds : DEFAULT_COOLDOWN_SECONDS;
  const explicit = findExplicitRetryDelaySeconds(bodyLike);
  const hint = Number(opts.retryDelaySecondsHint);
  let seconds;
  if (explicit !== null) {
    seconds = explicit;
  } else if (Number.isFinite(hint) && hint > 0) {
    seconds = hint;
  } else {
    seconds = def;
  }
  const until = now + Math.ceil(seconds * 1000) + 500;
  // M3: quota theo ngày + không có retryDelay tường minh -> đợi tới reset (nửa đêm PT)
  if (explicit === null && (!Number.isFinite(hint) || hint <= 0) && mentionsDailyQuota(bodyLike)) {
    const dailyResetAt = Number(opts.dailyResetAt) || 0;
    if (dailyResetAt > until) return dailyResetAt;
  }
  return until;
}

module.exports = {
  extractRetryDelaySeconds,
  findExplicitRetryDelaySeconds,
  mentionsDailyQuota,
  cooldownUntilFor429,
  DEFAULT_COOLDOWN_SECONDS,
};
