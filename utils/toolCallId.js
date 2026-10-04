'use strict';
/**
 * utils/toolCallId — nơi định nghĩa DUY NHẤT format `tool_call_id` của proxy.
 *
 * Tách ra khỏi `api/translate.js` vì 2 consumer khác nhau:
 *   - `api/translate.js`    (chế độ legacy `upstream_mode=translate`)
 *   - `api/signatureShim.js` (chế độ `upstream_mode=openai_compat` — Case B)
 * `api/signatureShim.js` KHÔNG được require `api/translate.js` (vòng phụ thuộc
 * `api/` → `api/`), và khi `translate.js` bị xoá (plan §8) thì shim vẫn sống.
 *
 * Format:
 *   - Có signature : `callsig_<encName>_<rand>_<sig>`
 *   - Không sig    : `call_<encName>_<rand>`
 * `encName` được encode để không còn ký tự `_` -> parse tách từ trái là chắc chắn.
 */

/**
 * Tạo tool_call_id — nhúng tên function (encoded) để map lại đúng khi client trả
 * tool result, kể cả parallel/out-of-order.
 *
 * Nếu có `thoughtSignature` (Gemini 3 bắt buộc replay khi gửi lại history functionCall
 * — xem plan §4.5) thì nhúng luôn vào id dạng `callsig_<name>_<rand>_<sig>`:
 * OpenAI format không có chỗ chứa signature và client không echo field lạ, nên id là
 * kênh duy nhất sống sót qua cả restart proxy (không cần state).
 *
 * @param {string} name
 * @param {string} [thoughtSignature]
 * @returns {string}
 */
function makeToolCallId(name, thoughtSignature) {
  const rand = Math.random().toString(36).slice(2, 10);
  if (typeof thoughtSignature === 'string' && thoughtSignature.length > 0 && thoughtSignature.length <= 8192) {
    // encodedName không còn '_' (đổi thành %5F) để parse không bị nhầm với rand/sig
    const encName = encodeURIComponent(name).replace(/_/g, '%5F');
    return `callsig_${encName}_${rand}_${thoughtSignature}`;
  }
  return `call_${encodeURIComponent(name)}_${rand}`;
}

/**
 * Parse tool_call_id -> { name?, thoughtSignature?, rand? }.
 * - Format mới `callsig_<encName>_<rand>_<sig>`: encName không chứa '_', nên tách từ trái là chắc chắn;
 *   sig là đuôi nên chứa ký tự gì (kể cả '_') cũng không phá parse.
 * - Format cũ `call_<encName>_<rand>` (id client tự tạo / không có signature): name + rand (không sig).
 * - Không nhận diện được -> {} (caller rơi về FIFO như cũ).
 *
 * @param {string} toolCallId
 * @returns {{ name?: string, thoughtSignature?: string, rand?: string }}
 */
function parseToolCallId(toolCallId) {
  if (typeof toolCallId !== 'string') return {};
  const n = /^callsig_([^_]+)_([a-z0-9]{1,16})_(.+)$/.exec(toolCallId);
  if (n) {
    let name;
    try { name = decodeURIComponent(n[1]); } catch (_) { name = n[1]; }
    return { name, thoughtSignature: n[3], rand: n[2] };
  }
  const m = /^call_(.+)_([a-z0-9]{2,16})$/.exec(toolCallId);
  if (m) {
    let name;
    try { name = decodeURIComponent(m[1]); } catch (_) { name = m[1]; }
    return { name, rand: m[2] };
  }
  return {};
}

module.exports = { makeToolCallId, parseToolCallId };
