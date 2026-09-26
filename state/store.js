const fs = require('fs');
const path = require('path');
const { nextMidnightPacific } = require('../utils/time');

function blankPairState(nowMs) {
  return {
    request_timestamps: [],
    daily_count: 0,
    daily_reset_at: nextMidnightPacific(nowMs !== undefined ? nowMs : Date.now()),
    token_timestamps: [],
    cooldown_until: 0,
    // Transient, KHÔNG persist (xem persist()): giữ chỗ cho request đang bay
    // để các request đồng thời không cùng thấy 1 slot còn trống (edge case #3).
    inflight_count: 0,
    inflight_tokens: 0,
  };
}

/**
 * Quản lý state của tất cả cặp (key, model). Load từ disk lúc khởi động,
 * ghi lại disk sau mỗi thay đổi quan trọng (debounce nếu cần).
 */
class StateStore {
  constructor(statePath) {
    this.statePath = statePath;
    /** @type {Map<string, PairState>} */
    this.map = new Map();
    if (statePath && fs.existsSync(statePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        const pairs = raw.pairs || raw;
        for (const [k, v] of Object.entries(pairs)) {
          this.map.set(k, {
            request_timestamps: Array.isArray(v.request_timestamps) ? v.request_timestamps : [],
            daily_count: Number(v.daily_count) || 0,
            daily_reset_at: Number(v.daily_reset_at) || nextMidnightPacific(Date.now()),
            token_timestamps: Array.isArray(v.token_timestamps) ? v.token_timestamps : [],
            cooldown_until: Number(v.cooldown_until) || 0,
            // inflight là transient của process cũ -> luôn reset về 0 khi load
            inflight_count: 0,
            inflight_tokens: 0,
          });
        }
      } catch (e) {
        console.warn(`[StateStore] cannot load state file ${statePath}: ${e.message}, starting fresh`);
      }
    }
  }

  _k(keyId, modelName) {
    return `${keyId}::${modelName}`;
  }

  /** @returns {PairState} */
  get(keyId, modelName) {
    const k = this._k(keyId, modelName);
    let st = this.map.get(k);
    if (!st) {
      st = blankPairState(Date.now());
      this.map.set(k, st);
    }
    return st;
  }

  maybeResetDaily(pairState, nowMs) {
    if (nowMs >= pairState.daily_reset_at) {
      pairState.daily_count = 0;
      pairState.daily_reset_at = nextMidnightPacific(nowMs);
      return true;
    }
    return false;
  }

  /** Ghi nhận 1 request thành công: thêm timestamp, +1 daily_count, thêm token usage */
  recordSuccess(keyId, modelName, tokensUsed) {
    const now = Date.now();
    const st = this.get(keyId, modelName);
    this.maybeResetDaily(st, now);
    this.pruneOldEntries(st, now);
    st.request_timestamps.push(now);
    st.daily_count += 1;
    const t = Number(tokensUsed) || 0;
    if (t > 0) st.token_timestamps.push([now, t]);
    this.persist();
    return st;
  }

  /** Đặt cooldown cho 1 cặp tới thời điểm unblockAtMs */
  setCooldown(keyId, modelName, unblockAtMs) {
    const st = this.get(keyId, modelName);
    st.cooldown_until = Math.max(st.cooldown_until || 0, Number(unblockAtMs) || 0);
    this.persist();
    return st;
  }

  /**
   * Giữ chỗ cho 1 request sắp bay: tăng bộ đếm inflight để các request đồng thời
   * khác thấy slot đã có chủ (edge case #3). Phải gọi reserve NGAY khi select
   * (đồng bộ, không await ở giữa) và gọi release() khi request kết thúc.
   * Cố ý KHÔNG persist: inflight là transient của process hiện tại.
   */
  reserve(keyId, modelName, estimatedTokens) {
    const st = this.get(keyId, modelName);
    st.inflight_count = (Number(st.inflight_count) || 0) + 1;
    st.inflight_tokens = (Number(st.inflight_tokens) || 0) + (Number(estimatedTokens) || 0);
    return st;
  }

  /** Trả chỗ đã giữ bằng reserve(). Luôn gọi trong mọi nhánh kết thúc request. */
  release(keyId, modelName, estimatedTokens) {
    const st = this.get(keyId, modelName);
    st.inflight_count = Math.max(0, (Number(st.inflight_count) || 0) - 1);
    st.inflight_tokens = Math.max(0, (Number(st.inflight_tokens) || 0) - (Number(estimatedTokens) || 0));
    return st;
  }

  /** Dọn các timestamp cũ hơn 60s khỏi mảng (gọi trước khi tính RPM/TPM) */
  pruneOldEntries(pairState, nowMs) {
    const cutoff = nowMs - 60000;
    if (Array.isArray(pairState.request_timestamps)) {
      pairState.request_timestamps = pairState.request_timestamps.filter((ts) => ts > cutoff);
    } else {
      pairState.request_timestamps = [];
    }
    if (Array.isArray(pairState.token_timestamps)) {
      pairState.token_timestamps = pairState.token_timestamps.filter(
        (e) => Array.isArray(e) && e[0] > cutoff
      );
    } else {
      pairState.token_timestamps = [];
    }
    return pairState;
  }

  /** Lưu toàn bộ state ra file (JSON.stringify). Inflight bị lược bỏ vì là transient. */
  persist() {
    if (!this.statePath) return;
    try {
      const dir = path.dirname(this.statePath);
      if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const pairs = {};
      for (const [k, st] of this.map.entries()) {
        const { inflight_count, inflight_tokens, ...durable } = st;
        void inflight_count;
        void inflight_tokens;
        pairs[k] = durable;
      }
      fs.writeFileSync(this.statePath, JSON.stringify({ pairs }, null, 2), 'utf8');
    } catch (e) {
      console.warn(`[StateStore] persist failed: ${e.message}`);
    }
  }

  /** Thời gian cooldown còn lại ngắn nhất (ms), 0 nếu không có cặp nào cooldown */
  minCooldownRemaining(nowMs, filterKeys) {
    let min = Infinity;
    for (const [, st] of this.map.entries()) {
      if (st.cooldown_until > nowMs) min = Math.min(min, st.cooldown_until - nowMs);
    }
    void filterKeys;
    return min === Infinity ? 0 : min;
  }

  snapshot() {
    const out = {};
    for (const [k, v] of this.map.entries()) out[k] = { ...v };
    return out;
  }
}

module.exports = { StateStore };
