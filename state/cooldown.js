/**
 * KIỂM TRA THUẦN — không mutate pairState (contract mới, xem AGENTS.md §3).
 * Reset daily_count phải được gọi riêng qua StateStore.resetDailyIfNeeded().
 * @param {PairState} pairState
 * @param {ModelLimits} limits
 * @param {number} nowMs
 * @param {number} estimatedTokens  // ước lượng token của request sắp gửi
 * @returns {boolean} true nếu cặp này còn khả dụng để gọi
 */
function isAvailable(pairState, limits, nowMs, estimatedTokens) {
  if (!pairState || !limits) return false;
  const now = Number(nowMs);
  const est = Number(estimatedTokens) || 0;

  if ((pairState.cooldown_until || 0) > now) return false;

  // RPD: Cộng inflight để burst đồng thời không vượt RPD.
  // (daily_count đã được reset bởi resetDailyIfNeeded trước khi gọi isAvailable)
  if ((pairState.daily_count || 0) + (pairState.inflight_count || 0) >= limits.rpd) return false;

  // RPM: sliding window 60s (không mutate mảng gốc quá mức cần thiết).
  // Cộng inflight: request đã giữ chỗ nhưng chưa recordSuccess vẫn chiếm slot.
  const cutoff = now - 60000;
  let recentRequests = 0;
  if (Array.isArray(pairState.request_timestamps)) {
    for (const ts of pairState.request_timestamps) if (ts > cutoff) recentRequests++;
  }
  if (recentRequests + (pairState.inflight_count || 0) >= limits.rpm) return false;

  // TPM: sliding window 60s
  let recentTokens = 0;
  if (Array.isArray(pairState.token_timestamps)) {
    for (const e of pairState.token_timestamps) {
      if (Array.isArray(e) && e[0] > cutoff) recentTokens += Number(e[1]) || 0;
    }
  }
  if (recentTokens + (pairState.inflight_tokens || 0) + est > limits.tpm) return false;

  return true;
}

module.exports = { isAvailable };
