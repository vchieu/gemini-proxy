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
 *      (tái dùng `makeToolCallId`/`parseToolCallId` của `api/translate.js`).
 *
 * Không require `api/server.js` (tránh vòng — xem AGENTS.md §7).
 */

const { makeToolCallId, parseToolCallId } = require('./translate');

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
 * @param {{ names?: Record<string|number, string> }} [state]
 *   state do caller giữ theo từng request — dùng khi `function.name` nằm ở delta
 *   TRƯỚC delta mang signature (id chỉ được cấp ở delta đầu nên cần ghi tên lại).
 * @returns {{ chunk: object, changed: boolean, unshimmed: boolean }}
 *   `changed`   — caller phải forward `JSON.stringify(chunk)` thay vì payload gốc.
 *   `unshimmed` — có signature nhưng không gắn được vào id (thiếu tên function);
 *                 caller nên WARN: client sẽ làm rơi `extra_content` -> replay 400.
 */
function chunkToClient(chunk, state) {
  // Chuẩn hoá state tại chỗ để caller có thể truyền `{}` — nếu không, mỗi lần gọi
  // lại tạo object `names` mới và tên function không được ghi nhớ giữa các delta.
  const st = state && typeof state === 'object' ? state : {};
  if (!st.names || typeof st.names !== 'object') st.names = {};
  const names = st.names;
  const out = { chunk, changed: false, unshimmed: false };
  const choices = chunk && chunk.choices;
  if (!Array.isArray(choices)) return out;
  for (const c of choices) {
    const delta = c && c.delta;
    if (!delta || !Array.isArray(delta.tool_calls)) continue;
    delta.tool_calls.forEach((tc, i) => {
      if (!tc || typeof tc !== 'object') return;
      const idx = typeof tc.index === 'number' ? tc.index : i;
      const name = (tc.function && typeof tc.function.name === 'string' && tc.function.name) || names[idx];
      if (name) names[idx] = name;
      const sig = readThoughtSignature(tc);
      if (!sig) return;
      if (!name) {
        // Không có tên -> không dựng được id (id đã phát ở delta trước không sửa lại được)
        out.unshimmed = true;
        return;
      }
      tc.id = makeToolCallId(name, sig);
      delete tc.extra_content;
      out.changed = true;
    });
  }
  return out;
}

module.exports = { responseToClient, requestToUpstream, chunkToClient, readThoughtSignature };
