const express = require('express');
const { handleNativeRequest, openNativeStream, Aggregated429Error } = require('../router/fallbackLoop');
const { cooldownUntilFor429, DEFAULT_COOLDOWN_SECONDS } = require('../client/errorParser');
const { logger } = require('../utils/logger');

function sendGeminiError(res, e, config) {
  if (e instanceof Aggregated429Error || e.status === 429) {
    const ra = e.retryAfterSeconds || (config && config.default_cooldown_seconds) || 30;
    res.set('Retry-After', String(Math.ceil(ra)));
    return res.status(429).json({ error: { code: 429, message: e.message, status: 'RESOURCE_EXHAUSTED' } });
  }
  const status = Number.isInteger(e.status) ? e.status : 500;
  if (e.body && e.body.error) return res.status(status).json(e.body); // lỗi Google gốc
  return res.status(status).json({ error: { code: status, message: e.message || 'Internal error', status: e.status >= 500 ? 'INTERNAL_ERROR' : 'UNKNOWN' } });
}

function parseModelAction(s) {
  const i = s.lastIndexOf(':');
  return i < 0 ? null : { model: s.slice(0, i), action: s.slice(i + 1) };
}

function createGeminiNativeRouter(deps) {
  const router = express.Router();
  const { models, config, stateStore } = deps;

  router.post('/models/:modelAction', async (req, res) => {
    const parsed = parseModelAction(req.params.modelAction);
    if (!parsed || !['generateContent', 'streamGenerateContent'].includes(parsed.action)) {
      return res.status(404).json({ error: { code: 404, message: `Unsupported method: ${req.params.modelAction}`, status: 'NOT_FOUND' } });
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: { code: 400, message: 'Request body must be a JSON object', status: 'INVALID_ARGUMENT' } });
    }
    if (parsed.action === 'generateContent') {
      // Client ngắt kết nối giữa chừng -> huỷ luôn upstream request, không giữ
      // reservation tới khi timeout 60s (signal đi qua ctx của withFallback).
      const aborter = new AbortController();
      const onCloseAbort = () => { if (!res.writableEnded) aborter.abort(); };
      res.on('close', onCloseAbort);
      try {
        const r = await handleNativeRequest(parsed.model, body, deps, { signal: aborter.signal });
        return res.json(r.geminiResponse);
      } catch (e) {
        if (e.status === 499 || res.destroyed) return; // client đã đi mất
        return sendGeminiError(res, e, config);
      } finally {
        res.off('close', onCloseAbort);
      }
    }
    return streamNative(req, res, parsed.model, body, deps).catch((e) => sendGeminiError(res, e, config));
  });

  // GET /models — shape GOOGLE ListModels: { models: [{ name: 'models/<id>', ... }] }
  // (không phải shape OpenAI { object, data } — SDK Google sẽ parse field `models`).
  router.get('/models', (req, res) => {
    res.json({
      models: models.map((m) => ({
        name: `models/${m.name}`,
        displayName: m.name,
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
      })),
    });
  });

  return router;
}

/**
 * Xử lý stream native (gemini-native endpoint).
 * - Forward byte SSE nguyên bản (không parse sang OpenAI format)
 * - Không ghi [DONE] (Gemini-native không có)
 * - Parse usageMetadata từ cạnh để tính quota
 * - Client disconnect -> KHÔNG recordSuccess
 * - Stream hoàntat -> recordSuccess
 */
async function streamNative(req, res, requestedModel, body, deps) {
  const { upstream, pair, estimated, release } = await openNativeStream(requestedModel, body, deps);
  const { stateStore } = deps;

  // Lấy reader TRƯỚC khi ghi header — nếu fail thì trả lỗi JSON được (chưa writeHead)
  let reader;
  try {
    reader = upstream.body.getReader();
  } catch (e) {
    release();
    return sendGeminiError(res, e, deps.config);
  }

  let totalTokens = estimated;
  let clientAborted = false;
  let streamCompleted = false;
  let streamError = null;

  // writeHead nằm NGOÀI try/read-loop bên dưới -> tự guard để không leak reservation (M1 còn dư)
  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
  } catch (e) {
    release();
    if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
    return sendGeminiError(res, e, deps.config);
  }

  res.on('close', () => {
    if (!res.writableEnded) {
      clientAborted = true;
      reader.cancel().catch(() => {});
    }
  });

  // Dữ liệu SSE đang đượcaccumulate (gộp multi-line data:)
  let dataLines = [];
  // Ghi nhận lỗi in-band từ upstream (dùng chung cho handleLine + event cuối)
  const noteUpstreamError = (errObj) => {
    streamError = new Error(errObj.message || 'Upstream stream error');
    streamError.status = errObj.code || 500;
    streamError.alreadyEmitted = true;
    logger.error(`Native stream error in chunk: ${streamError.message}`);
    // M2: 429 in-band mid-stream PHẢI set cooldown — nếu không request kế tiếp
    // lại chọn đúng cặp vừa cạn quota và fail y hệt.
    if (streamError.status === 429) {
      const pairState = stateStore.get(pair.key.id, pair.model.name);
      const cooldownUntil = cooldownUntilFor429(
        { error: errObj },
        {
          defaultCooldownSeconds: (deps.config && deps.config.default_cooldown_seconds) || DEFAULT_COOLDOWN_SECONDS,
          dailyResetAt: pairState.daily_reset_at,
        }
      );
      stateStore.setCooldown(pair.key.id, pair.model.name, cooldownUntil);
      logger.warn('Native stream: in-band 429 -> set cooldown', {
        key: pair.key.id,
        model: pair.model.name,
        cooldown_until: new Date(cooldownUntil).toISOString(),
      });
    }
  };
  let buffer = '';
  // H1: decoder DUY NHẤT cho cả stream — decode từng chunk network riêng lẻ sẽ
  // hỏng ký tự UTF-8 đa-byte bị cắt đôi ở ranh giới chunk (thành U+FFFD).
  const decoder = new TextDecoder('utf-8');
  const handleLine = (line) => {
    const l = line.replace(/\r$/, '');
    if (l === '') {
      if (dataLines.length > 0) {
        // Process the accumulated event
        const eventText = dataLines.join('\n');
        dataLines = [];
        try {
          const g = JSON.parse(eventText);
          const errObj = (g && g.error) || (Array.isArray(g) && g[0] && g[0].error);
          if (errObj) {
            noteUpstreamError(errObj);
          } else if (g.usageMetadata && g.usageMetadata.totalTokenCount) {
            totalTokens = g.usageMetadata.totalTokenCount;
          }
        } catch (_) {
          // không phải JSON valid, bỏ qua (không làm rối quota)
        }
      }
      return;
    }
    if (l.startsWith('data:')) dataLines.push(l.slice(5).replace(/^ /, ''));
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (clientAborted || streamError) { reader.cancel().catch(() => {}); break; }

      // Ghi byte nguyên bản lên response
      res.write(value);

      // Parse text để tìm data: lines (decoder stream -> không hỏng UTF-8 đa-byte, H1)
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        handleLine(line);
        if (streamError) break;
      }
      if (clientAborted || streamError) break;
    }
    buffer += decoder.decode(); // flush byte còn sót (hoàn tất multi-byte cuối nếu có)
    // Đọc còn buffer (dòng cuối không có \n)
    if (!clientAborted && !streamError && buffer.trim()) handleLine(buffer);
    // Xử lý event cuối thiếu dòng trống
    if (!clientAborted && !streamError && dataLines.length > 0) {
      const eventText = dataLines.join('\n');
      try {
        const g = JSON.parse(eventText);
        const errObj = (g && g.error) || (Array.isArray(g) && g[0] && g[0].error);
        if (errObj) {
          noteUpstreamError(errObj);
        } else if (g.usageMetadata && g.usageMetadata.totalTokenCount) {
          totalTokens = g.usageMetadata.totalTokenCount;
        }
      } catch (_) {}
    }
    streamCompleted = !clientAborted && !streamError;
  } catch (e) {
    logger.error(`Native stream read error: ${e.message}`);
    streamError = e;
  } finally {
    release();
    // M6: nhánh break vì in-band error KHÔNG hề cancel reader -> kết nối upstream
    // bị giữ tới idle timeout 60s. Cancel ở đây là no-op nếu stream đã đóng.
    reader.cancel().catch(() => {});

    if (streamError && !clientAborted) {
      if (!streamError.alreadyEmitted && !res.writableEnded && !res.destroyed) {
        const errPayload = { error: { code: streamError.status || 502, message: streamError.message, status: 'UNAVAILABLE' } };
        res.write(`data: ${JSON.stringify(errPayload)}\n\n`);
      }
    } else if (!clientAborted && streamCompleted) {
      stateStore.recordSuccess(pair.key.id, pair.model.name, totalTokens);
    }
    // KHÔNG được quên res.end() — nếu không client treo vô hạn chờ kết thúc SSE
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}

module.exports = { createGeminiNativeRouter };