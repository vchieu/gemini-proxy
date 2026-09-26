const DEFAULT_COOLDOWN_SECONDS = 30;

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
 * @param {object|string} errorResponseBody  // body JSON trả về từ Gemini khi lỗi
 * @returns {number}  // số giây cần chờ trước khi retry
 */
function extractRetryDelaySeconds(errorResponseBody) {
  try {
    if (errorResponseBody == null) return DEFAULT_COOLDOWN_SECONDS;
    if (typeof errorResponseBody === 'string') {
      const m = /retry in ([\d.]+)s/i.exec(errorResponseBody);
      if (m) return parseFloat(m[1]);
      const d = parseDurationToSeconds(errorResponseBody);
      return d !== null && Number.isFinite(d) && d > 0 ? d : DEFAULT_COOLDOWN_SECONDS;
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
  return DEFAULT_COOLDOWN_SECONDS;
}

module.exports = { extractRetryDelaySeconds, DEFAULT_COOLDOWN_SECONDS };
