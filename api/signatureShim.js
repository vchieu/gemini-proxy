'use strict';
/**
 * signatureShim — chuyển đổi qua lại giữa:
 *   - OpenAI-compat của Google: `tool_calls[].extra_content.google.thought_signature`
 *   - OpenAI "sạch" cho agent:  `tool_calls[].id = callsig_<name>_<rand>_<sig>`
 *
 * Tại sao cần (kết luận live test Phase 6 / plan §1.4 Q1–Q2 — **Case B**):
 *   - Q1: signature nằm ở `message.tool_calls[0].extra_content.google.thought_signature`
 *     (đúng shape plan gợi ý, cùng object với tool_call).
 *   - Q2: client OpenAI chuẩn KHÔNG echo field lạ `extra_content` -> replay history
 *     bị Google 400 `Function call is missing a thought_signature`.
 *   -> Kênh duy nhất sống sót qua client là `tool_call_id`, nên nhúng sig vào id
 *      (dùng `makeToolCallId`/`parseToolCallId` của `utils/toolCallId.js` —
 *      KHÔNG require `api/translate.js` để tránh phụ thuộc vòng trong `api/`).
 *
 * Không require `api/server.js` (tránh vòng — xem AGENTS.md §7).
 */

const { makeToolCallId, parseToolCallId } = require('../utils/toolCallId');

/**
 * Đọc thoughtSignature từ 1 tool_call Google trả về.
 * Ưu tiên shape đã quan sát thật: `extra_content.google.thought_signature`.
 * @param {object} tc
 * @returns {string|undefined}
 */
function readThoughtSignature(tc) {
  const ec = tc && tc.extra_content;
  if (!ec || typeof ec !== 'object') return undefined;
  if (ec.google && typeof ec.google === 'object'
    && typeof ec.google.thought_signature === 'string' && ec.google.thought_signature) {
    return ec.google.thought_signature;
  }
  // phòng shape khác (không quan sát được nhưng không được nuốt mất sig)
  if (typeof ec.thought_signature === 'string' && ec.thought_signature) return ec.thought_signature;
  return undefined;
}

/**
 * Response NON-STREAM -> client: nhúng sig vào id, bỏ `extra_content`.
 * Mutate tại chỗ (JSON đã parse của riêng request này) rồi trả về.
 * @param {object} openAiResponse
 * @returns {object}
 */
function responseToClient(openAiResponse) {
  const choices = openAiResponse && openAiResponse.choices;
  if (!Array.isArray(choices)) return openAiResponse;
  for (const c of choices) {
    const msg = c && c.message;
    if (!msg || !Array.isArray(msg.tool_calls)) continue;
    for (const tc of msg.tool_calls) {
      if (!tc || typeof tc !== 'object') continue;
      const sig = readThoughtSignature(tc);
      if (!sig) continue;
      const name = (tc.function && tc.function.name) || 'tool';
      tc.id = makeToolCallId(name, sig);
      delete tc.extra_content;
    }
  }
  return openAiResponse;
}

/**
 * Request -> upstream: đảo ngược — lấy sig từ `tool_calls[].id` (format `callsig_…`)
 * của các message assistant trong history rồi dựng lại `extra_content`.
 * Mutate tại chỗ và trả về (idempotent: đã có sig thì bỏ qua).
 * @param {object} agentRequest body OpenAI của agent
 * @returns {object}
 */
function requestToUpstream(agentRequest) {
  const msgs = agentRequest && agentRequest.messages;
  if (!Array.isArray(msgs)) return agentRequest;
  for (const m of msgs) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      if (!tc || typeof tc !== 'object' || typeof tc.id !== 'string') continue;
      if (readThoughtSignature(tc)) continue; // client đã echo field lạ -> giữ nguyên
      const { thoughtSignature } = parseToolCallId(tc.id);
      if (!thoughtSignature) continue;
      const base = (tc.extra_content && typeof tc.extra_content === 'object') ? { ...tc.extra_content } : {};
      tc.extra_content = { ...base, google: { ...(base.google && typeof base.google === 'object' ? base.google : {}), thought_signature: thoughtSignature } };
    }
  }
  return agentRequest;
}

/**
 * Chunk STREAM -> client.
 *
 * @param {object} chunk   payload JSON 1 event SSE (đã parse)
 * @param {object} [state] state do caller giữ THEO TỪNG REQUEST, gồm:
 *   - `names`        — tên function đã thấy theo index (sig có thể đến sau delta có `function.name`)
 *   - `indexById`    — ánh xạ `id` -> index để giữ index ổn định giữa các delta
 *   - `emitted`, `emittedWithSig` — index nào đã forward id / đã forward id kèm sig
 *   - `nextIndex`, `lastIndex`    — cấp index mới cho tool_call Google không đánh số
 *   Caller truyền `{}` cũng được — các field thiếu được khởi tạo tại chỗ.
 * @returns {{ chunk: object, changed: boolean, unshimmed: boolean, late: boolean }}
 *   `changed`   — caller phải forward `JSON.stringify(chunk)` thay vì payload gốc.
 *   `unshimmed` — có signature nhưng không gắn được vào id (thiếu tên function);
 *                 caller nên WARN: client sẽ làm rơi `extra_content` -> replay 400.
 *   `late`      — signature đến SAU khi id đã được forward cho index đó; client đã giữ
 *                 id cũ nên không cập nhật được -> caller nên WARN (replay có thể 400).
 */
function chunkToClient(chunk, state) {
  // Chuẩn hoá state tại chỗ để caller có thể truyền `{}` — nếu không, mỗi lần gọi
  // lại tạo object mới và tên function / chỉ số tool_call không được ghi nhớ giữa các delta.
  const st = state && typeof state === 'object' ? state : {};
  if (!st.names || typeof st.names !== 'object') st.names = {};
  if (!st.indexById || typeof st.indexById !== 'object') st.indexById = {};
  if (!st.emitted || typeof st.emitted !== 'object') st.emitted = {};
  if (!st.emittedWithSig || typeof st.emittedWithSig !== 'object') st.emittedWithSig = {};
  if (typeof st.nextIndex !== 'number') st.nextIndex = 0;
  if (typeof st.lastIndex !== 'number') st.lastIndex = 0;
  const names = st.names;
  const out = { chunk, changed: false, unshimmed: false, late: false };
  const choices = chunk && chunk.choices;
  if (!Array.isArray(choices)) return out;
  for (const c of choices) {
    const delta = c && c.delta;
    if (!delta || !Array.isArray(delta.tool_calls)) continue;
    const tcs = delta.tool_calls;
    tcs.forEach((tc, i) => {
      if (!tc || typeof tc !== 'object') return;

      // (1) `index` — OpenAI spec BẮT BUỘC trên delta `tool_calls` của stream, nhưng
      // Google KHÔNG gửi (L6: sawIndex=false). Client OpenAI nghiêm ngặt từng làm hỏng
      // nhánh `translate` vì thiếu field này -> điền vào, CHỈ khi thiếu (không ghi đè).
      const id = (typeof tc.id === 'string' && tc.id) ? tc.id : null;
      let idx;
      if (typeof tc.index === 'number') {
        idx = tc.index;
      } else if (id && Object.prototype.hasOwnProperty.call(st.indexById, id)) {
        idx = st.indexById[id]; // delta lặp lại cùng id -> giữ index cũ
      } else if (id) {
        idx = st.nextIndex++; // id mới -> tool_call mới
      } else if (tcs.length > 1) {
        idx = i; // nhiều tool_call trong 1 delta mà không id/index -> theo vị trí
      } else {
        idx = st.lastIndex; // continuation 1 phần tử -> tool_call đang nói dở
      }
      if (idx + 1 > st.nextIndex) st.nextIndex = idx + 1;
      st.lastIndex = idx;
      if (id) st.indexById[id] = idx;
      if (typeof tc.index !== 'number') { tc.index = idx; out.changed = true; }

      // (2) tên function — có thể nằm ở delta khác với signature
      const name = (tc.function && typeof tc.function.name === 'string' && tc.function.name) || names[idx];
      if (name) names[idx] = name;

      // (3) signature -> nhúng vào id, bỏ field lạ client không echo
      const sig = readThoughtSignature(tc);
      if (sig) {
        if (!name) {
          // Không có tên -> không dựng được id (id đã phát ở delta trước không sửa lại được)
          out.unshimmed = true;
        } else {
          tc.id = makeToolCallId(name, sig);
          delete tc.extra_content;
          out.changed = true;
        }
        // id của index này đã được forward Ở DELTA TRƯỚC mà chưa kèm sig -> client
        // đã giữ id cũ và không cập nhật lại -> replay history sẽ thiếu signature.
        if (st.emitted[idx] && !st.emittedWithSig[idx]) out.late = true;
      }
      if (typeof tc.id === 'string' && tc.id) {
        st.emitted[idx] = true;
        if (sig) st.emittedWithSig[idx] = true;
      }
    });
  }
  return out;
}

module.exports = { responseToClient, requestToUpstream, chunkToClient, readThoughtSignature };
