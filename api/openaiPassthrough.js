const { logger } = require('../utils/logger');
const { chunkToClient } = require('./signatureShim');

/**
 * Stream passthrough SSE cho `upstream_mode=openai_compat` (xem plan
 * PLAN-openai-compat-migration.md Phase 4.2).
 *
 * Xử lý ở mức EVENT SSE (không pipe byte thuần) để:
 *  - gom event `data:` đúng spec (nhiều dòng nối bằng '\n', event kết thúc tại
 *    dòng trống, xử lý '\r'),
 *  - lọc chunk usage-only (`choices: []`) khi agent KHÔNG xin
 *    `stream_options.include_usage` (client strict có thể lỗi với choices rỗng),
 *  - ghi `usage.total_tokens` vào quota,
 *  - tự ghi `data: [DONE]` nếu upstream không gửi.
 *
 * Payload được forward **nguyên văn** (không JSON.parse → stringify lại) để giữ
 * đúng byte/field lạ của Google.
 *
 * `sendError`/`errorToOpenAi` truyền qua tham số để KHÔNG require `api/server.js`
 * (tránh require vòng — xem AGENTS.md §7).
 *
 * @param {object} opts
 * @param {import('http').IncomingMessage} opts.req
 * @param {import('http').ServerResponse} opts.res
 * @param {{ upstream, pair, estimated, release: () => void }} opts.handle
 *   kết quả `openStream()` — `release` đã idempotent
 * @param {object} opts.agentRequest body OpenAI gốc của agent
 * @param {{ stateStore, geminiClient, models, keys, config }} opts.deps
 * @param {(res, e, config) => void} opts.sendError
 * @param {(status, message, code?) => object} opts.errorToOpenAi
 */
async function streamOpenAiPassthrough({ req, res, handle, agentRequest, deps, sendError, errorToOpenAi }) {
  const { stateStore, config } = deps;
  const { upstream, pair, estimated, release } = handle;
  const includeUsage = !!(agentRequest && agentRequest.stream_options && agentRequest.stream_options.include_usage === true);

  let reader;
  try {
    reader = upstream.body.getReader();
  } catch (e) {
    release();
    return sendError(res, e, config);
  }

  let clientAborted = false;
  let sawDone = false;
  let totalTokens = estimated;
  const shimState = { names: {} }; // tên function đã thấy theo index (dùng cho shim signature)

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  res.on('close', () => {
    if (!res.writableEnded) {
      clientAborted = true; // client ngắt → KHÔNG recordSuccess, KHÔNG [DONE]
      reader.cancel().catch(() => {});
    }
  });

  // Gom 1 event từ các dòng `data:`, trả payload (null nếu rỗng), reset dataLines.
  // (đóng tại đây để tái sử dụng cho buffer cuối)
  let dataLines = [];
  const takeEvent = () => {
    if (dataLines.length === 0) return null;
    const payload = dataLines.join('\n');
    dataLines = [];
    return payload;
  };

  /**
   * Xử lý 1 payload event: forward về client (hoặc lọc), ghi usage.
   * @param {string} payloadRaw payload sau khi nối các dòng data:
   */
  const forwardEvent = (payloadRaw) => {
    if (clientAborted) return;
    if (payloadRaw === '[DONE]') {
      sawDone = true;
      res.write('data: [DONE]\n\n');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(payloadRaw);
    } catch (_) {
      // Không parse được JSON → vẫn forward nguyên (để Google lỗi đi tới client)
      logger.warn('openai_passthrough: chunk SSE không parse được, forward nguyên', {
        payload: payloadRaw.slice(0, 300),
      });
      res.write(`data: ${payloadRaw}\n\n`);
      return;
    }
    if (parsed && parsed.usage && parsed.usage.total_tokens) {
      totalTokens = parsed.usage.total_tokens;
    }
    // Chunk usage-only (choices: []) → lọc nếu agent không xin usage
    const isUsageOnly = Array.isArray(parsed && parsed.choices) && parsed.choices.length === 0;
    if (isUsageOnly && !includeUsage) return;
    // Case B: nhúng thoughtSignature vào tool_call id (client không echo extra_content).
    // Chỉ re-stringify khi THẬT SỰ có gì đó đổi — còn lại giữ nguyên payload gốc.
    const shim = chunkToClient(parsed, shimState);
    if (shim.unshimmed) {
      logger.warn('openai_passthrough: không gắn được thoughtSignature vào tool_call id (thiếu tên function) — replay history có thể 400', {
        model: pair.model.name,
      });
    }
    if (shim.late) {
      logger.warn('openai_passthrough: thoughtSignature đến SAU khi id đã gửi cho client — client giữ id cũ, replay history có thể 400', {
        model: pair.model.name,
      });
    }
    res.write(`data: ${shim.changed ? JSON.stringify(shim.chunk) : payloadRaw}\n\n`);
  };

  // Đọc loop → tách dòng → gom event → forward
  let buffer = '';
  let streamError = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (clientAborted) break;
      buffer += Buffer.from(value).toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop(); // giữ lại phần chưa có '\n'
      for (const line of lines) {
        const l = line.replace(/\r$/, '');
        if (l === '') {
          const payload = takeEvent();
          if (payload !== null) forwardEvent(payload);
          continue;
        }
        if (l.startsWith('data:')) dataLines.push(l.slice(5).replace(/^ /, ''));
        // field khác (event:/id:/retry:) và comment (':') → bỏ qua
      }
      if (clientAborted) break;
    }
    if (!clientAborted && buffer) {
      const l = buffer.replace(/\r$/, '');
      if (l.startsWith('data:')) dataLines.push(l.slice(5).replace(/^ /, ''));
    }
    if (!clientAborted) {
      const last = takeEvent(); // event cuối thiếu dòng trống
      if (last !== null) forwardEvent(last);
    }
  } catch (e) {
    streamError = e;
    logger.error(`openai_passthrough: stream interrupted: ${e.message}`);
  }

  release(); // idempotent — mọi nhánh đều gọi đúng 1 lần

  if (streamError && !clientAborted) {
    // Lỗi giữa chừng: KHÔNG recordSuccess, KHÔNG [DONE], báo lỗi dạng OpenAI
    logger.error(`openai_passthrough: stream error, không recordSuccess`, { message: streamError.message });
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(errorToOpenAi(streamError.status || 502, streamError.message))}\n\n`);
    }
  } else if (!clientAborted) {
    // Hoàn tất sạch: recordSuccess + đảm bảo đúng 1 [DONE]
    stateStore.recordSuccess(pair.key.id, pair.model.name, totalTokens);
    if (!sawDone && !res.writableEnded) res.write('data: [DONE]\n\n');
  }

  if (!res.writableEnded) res.end(); // luôn kết thúc — thiếu → client treo vô hạn
}

module.exports = { streamOpenAiPassthrough };
