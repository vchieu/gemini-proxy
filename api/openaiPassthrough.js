const { logger } = require('../utils/logger');
const { chunkToClient } = require('./signatureShim');
const { cooldownUntilFor429, DEFAULT_COOLDOWN_SECONDS } = require('../client/errorParser');

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
  let streamError = null;
  const shimState = { names: {} }; // tên function đã thấy theo index (dùng cho shim signature)

  // Ghi SSE đúng spec: multi-line data được prefix `data:` từng dòng
  const writeSse = (data) => {
    if (res.writableEnded) return;
    const lines = String(data).split('\n');
    for (const line of lines) {
      res.write(`data: ${line}\n`);
    }
    res.write('\n');
  };

  try {
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
        writeSse('[DONE]');
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
        writeSse(payloadRaw);
        return;
      }

      // Phát hiện lỗi in-band mid-stream từ Google
      const errObj = (parsed && parsed.error) || (Array.isArray(parsed) && parsed[0] && parsed[0].error);
      if (errObj) {
        streamError = new Error(errObj.message || 'Stream error from upstream');
        streamError.status = errObj.code || 500;
        streamError.alreadyEmitted = true;
        logger.error('openai_passthrough: stream error in chunk', { message: streamError.message, status: streamError.status });
        // M2: 429 in-band mid-stream PHẢI set cooldown — nếu không, request kế
        // tiếp lại chọn đúng cặp vừa cạn quota và fail y hệt.
        if (streamError.status === 429) {
          const pairState = stateStore.get(pair.key.id, pair.model.name);
          const cooldownUntil = cooldownUntilFor429(
            { error: errObj },
            {
              defaultCooldownSeconds: (config && config.default_cooldown_seconds) || DEFAULT_COOLDOWN_SECONDS,
              dailyResetAt: pairState.daily_reset_at,
            }
          );
          stateStore.setCooldown(pair.key.id, pair.model.name, cooldownUntil);
          logger.warn('openai_passthrough: in-band 429 -> set cooldown', {
            key: pair.key.id,
            model: pair.model.name,
            cooldown_until: new Date(cooldownUntil).toISOString(),
          });
        }
        writeSse(payloadRaw);
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
      writeSse(shim.changed ? JSON.stringify(shim.chunk) : payloadRaw);
    };

    // Đọc loop → tách dòng → gom event → forward
    // H1: decoder DUY NHẤT cho cả stream — decode từng chunk network riêng lẻ sẽ
    // hỏng ký tự UTF-8 đa-byte bị cắt đôi ở ranh giới chunk (thành U+FFFD).
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (clientAborted || streamError) {
        reader.cancel().catch(() => {});
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // giữ lại phần chưa có '\n'
      for (const line of lines) {
        const l = line.replace(/\r$/, '');
        if (l === '') {
          const payload = takeEvent();
          if (payload !== null) forwardEvent(payload);
          if (streamError) break;
          continue;
        }
        if (l.startsWith('data:')) dataLines.push(l.slice(5).replace(/^ /, ''));
        // field khác (event:/id:/retry:) và comment (':') → bỏ qua
      }
      if (clientAborted || streamError) break;
    }
    buffer += decoder.decode(); // flush byte còn sót (hoàn tất multi-byte cuối nếu có)
    if (!clientAborted && !streamError && buffer) {
      const l = buffer.replace(/\r$/, '');
      if (l.startsWith('data:')) dataLines.push(l.slice(5).replace(/^ /, ''));
    }
    if (!clientAborted && !streamError) {
      const last = takeEvent(); // event cuối thiếu dòng trống
      if (last !== null) forwardEvent(last);
    }
  } catch (e) {
    if (!streamError) streamError = e;
    logger.error(`openai_passthrough: stream interrupted: ${e.message}`);
  } finally {
    release(); // idempotent — mọi nhánh đều gọi đúng 1 lần
    // M6: nhánh break vì in-band error KHÔNG hề cancel reader -> kết nối upstream
    // bị giữ tới idle timeout 60s. Cancel ở đây là no-op nếu stream đã đóng.
    reader.cancel().catch(() => {});

    if (streamError && !clientAborted) {
      // Lỗi giữa chừng: KHÔNG recordSuccess, KHÔNG [DONE], báo lỗi dạng OpenAI
      logger.error(`openai_passthrough: stream error, không recordSuccess`, { message: streamError.message });
      if (!res.writableEnded && !streamError.alreadyEmitted) {
        writeSse(JSON.stringify(errorToOpenAi(streamError.status || 502, streamError.message)));
      }
    } else if (!clientAborted && !streamError) {
      // Hoàn tất sạch: recordSuccess + đảm bảo đúng 1 [DONE]
      stateStore.recordSuccess(pair.key.id, pair.model.name, totalTokens);
      if (!sawDone && !res.writableEnded) writeSse('[DONE]');
    }

    if (!res.writableEnded) res.end(); // luôn kết thúc — thiếu → client treo vô hạn
  }
}

module.exports = { streamOpenAiPassthrough };
