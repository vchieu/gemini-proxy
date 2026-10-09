const fs = require('fs');
const path = require('path');
const { nextMidnightPacific } = require('../utils/time');

/**
 * Sleep đồng bộ bằng Atomics.wait — chỉ dùng khi persist THẤT BẠI (file đang bị
 * antivirus/instance khác giữ trên Windows -> EPERM/EACCES ở rename). Trường hợp
 * hiếm gặp nên việc block event loop vài chục ms là chấp nhận được.
 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    /* không sleep được thì bỏ qua, vẫn retry ngay */
  }
}

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
    this._persistDelay = 500; // ms — debounce để tránh sync write mỗi request
    this._persistTimer = null;
    this._retryTimer = null; // safety-net retry sau khi persist fail đủ 3 attempt
    if (statePath) this._cleanupStaleTmp();
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

  /**
   * Reset daily_count của 1 cặp nếu đã qua nửa đêm PT. Gọi TRƯỚC isAvailable()
   * để đảm bảo daily_count là fresh (isAvailable giờ là hàm thuần, không tự reset).
   * @returns {boolean} true nếu đã reset
   */
  resetDailyIfNeeded(keyId, modelName, nowMs) {
    const st = this.get(keyId, modelName);
    return this.maybeResetDaily(st, nowMs);
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
    this.schedulePersist();
    return st;
  }

  /** Đặt cooldown cho 1 cặp tới thời điểm unblockAtMs */
  setCooldown(keyId, modelName, unblockAtMs) {
    const st = this.get(keyId, modelName);
    st.cooldown_until = Math.max(st.cooldown_until || 0, Number(unblockAtMs) || 0);
    this.schedulePersist();
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

  /**
   * Debounced persist — gọi thay persist() trong recordSuccess/setCooldown
   * để tránh sync write mỗi request. Tests vẫn gọi persist() trực tiếp.
   */
  schedulePersist() {
    if (!this.statePath) return;
    if (this._persistTimer) return; // đã có timer chờ
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this.persist();
    }, this._persistDelay);
  }

  /**
   * Dọn file tmp sót lại từ lần persist fail trước (Windows EPERM) hoặc process
   * cũ chết giữa chừng. Hợp cả tên legacy `state.json.tmp` và tên theo pid
   * `state.json.<pid>.tmp`. Best-effort: file đang bị lock thì bỏ qua.
   */
  _cleanupStaleTmp() {
    try {
      const dir = path.dirname(this.statePath);
      const base = path.basename(this.statePath); // vd "state.json"
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        // "state.json.tmp" (legacy) và "state.json.<pid>.tmp" đều match;
        // chính "state.json" thì KHÔNG (thiếu dấu '.' sau base).
        if (!f.startsWith(`${base}.`) || !f.endsWith('.tmp')) continue;
        try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* đang bị lock -> bỏ qua */ }
      }
    } catch (_) {
      /* không đọc được thư mục -> bỏ qua, không được chặn khởi động */
    }
  }

  /**
   * Lưu toàn bộ state ra file (JSON.stringify). Inflight bị lược bỏ vì là transient.
   * @returns {boolean} true nếu đã ghi thành công
   */
  persist() {
    return this._writeState(true);
  }

  /**
   * Ghi state ra disk: tối đa 3 attempt (ghi .tmp + rename) với sleep 50/150ms
   * giữa các lần — che cửa sổ file bị lock trên Windows (antivirus, instance thứ 2
   * đọc đúng lúc rename -> EPERM/EACCES). Vẫn fail -> log đúng 1 lần và xếp tối đa
   * 1 lần retry an toàn sau 1s (timer unref, không xếp chồng, không lặp vô hạn:
   * lần retry do chính nó chạy sẽ không tự xếp tiếp).
   * @param {boolean} mayScheduleRetry false khi chạy từ timer safety-net
   * @returns {boolean} true nếu đã ghi xong
   */
  _writeState(mayScheduleRetry) {
    if (!this.statePath) return false;
    const tmpPath = `${this.statePath}.${process.pid}.tmp`; // theo pid: 2 process không đụng chung tmp
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) sleepSync(attempt === 1 ? 50 : 150);
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
        // Atomic write: ghi vào .tmp rồi rename để tránh corruption nếu crash giữa chừng
        fs.writeFileSync(tmpPath, JSON.stringify({ pairs }, null, 2), 'utf8');
        fs.renameSync(tmpPath, this.statePath);
        if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
        return true;
      } catch (e) {
        lastErr = e;
      }
    }
    console.warn(`[StateStore] persist failed after 3 attempts: ${lastErr.message} — state sẽ tự ghi lại ở lần mutation kế tiếp (hoặc retry an toàn sau 1s)`);
    if (mayScheduleRetry && !this._retryTimer) {
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null;
        this._writeState(false);
      }, 1000);
      if (typeof this._retryTimer.unref === 'function') this._retryTimer.unref(); // không giữ process sống
    }
    return false;
  }

  /** Huỷ debounce timer và ghi state ngay (dùng khi shutdown). */
  flush() {
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    this.persist();
  }

  /** Thời gian cooldown còn lại ngắn nhất (ms), 0 nếu không có cặp nào cooldown */
  minCooldownRemaining(nowMs) {
    let min = Infinity;
    for (const [, st] of this.map.entries()) {
      if (st.cooldown_until > nowMs) min = Math.min(min, st.cooldown_until - nowMs);
    }
    return min === Infinity ? 0 : min;
  }

  snapshot() {
    const out = {};
    for (const [k, v] of this.map.entries()) out[k] = { ...v };
    return out;
  }
}

module.exports = { StateStore };
