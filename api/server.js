const express = require('express');
const { handleRequest, openStream, Aggregated429Error } = require('../router/fallbackLoop');
const { geminiChunkToOpenAiChunk } = require('./translate');
const { logger } = require('../utils/logger');

function errorToOpenAi(status, message, code) {
  return { error: { message, type: code || (status === 429 ? 'rate_limit_exceeded' : 'api_error'), code: String(status) } };
}

function sendError(res, e, config) {
  if (e instanceof Aggregated429Error || e.status === 429) {
    const retryAfter = e.retryAfterSeconds || (config && config.default_cooldown_seconds) || 30;
    res.set('Retry-After', String(Math.ceil(retryAfter)));
    return res.status(429).json(errorToOpenAi(429, e.message));
  }
  const status = Number.isInteger(e.status) ? e.status : 500;
  return res.status(status).json(errorToOpenAi(status, e.message || 'Internal error'));
}

function createServer({ models, keys, stateStore, config, geminiClient }) {
  const client = geminiClient || require('../client/geminiClient');
  const deps = { models, keys, stateStore, geminiClient: client, config };
  const app = express();

  // Access log: method, path, status, duration. /health poll mỗi giây -> debug để không spam log.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const line = `${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - start}ms`;
      if (req.originalUrl.startsWith('/health')) logger.debug(line);
      else if (res.statusCode >= 400) logger.warn(line);
      else logger.info(line);
    });
    next();
  });

  app.use(express.json({ limit: '10mb' }));

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.get('/v1/models', (req, res) => {
    res.json({
      object: 'list',
      data: models.map((m) => ({ id: m.name, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'gemini-proxy' })),
    });
  });

  app.get('/admin/status', (req, res) => {
    const now = Date.now();
    const pairs = [];
    for (const m of models) {
      for (const k of keys) {
        stateStore.resetDailyIfNeeded(k.id, m.name, now); // #9
        const st = stateStore.get(k.id, m.name);
        stateStore.pruneOldEntries(st, now);
        const recentReq = st.request_timestamps.length;
        const recentTok = st.token_timestamps.reduce((s, e) => s + (Number(e[1]) || 0), 0);
        pairs.push({
          key: k.id,
          key_enabled: k.enabled !== false,
          model: m.name,
          rpm_used: recentReq,
          rpm_limit: m.limits.rpm,
          rpm_remaining: Math.max(0, m.limits.rpm - recentReq),
          rpd_used: st.daily_count,
          rpd_limit: m.limits.rpd,
          rpd_remaining: Math.max(0, m.limits.rpd - st.daily_count),
          tpm_used_60s: recentTok,
          tpm_limit: m.limits.tpm,
          cooldown_remaining_ms: Math.max(0, (st.cooldown_until || 0) - now),
          daily_reset_at: st.daily_reset_at,
        });
      }
    }
    res.json({ now, strategy: config.strategy, pairs });
  });

  app.post('/v1/chat/completions', async (req, res) => {
    const agentRequest = req.body || {};
    if (!Array.isArray(agentRequest.messages)) {
      return res.status(400).json(errorToOpenAi(400, 'Field "messages" (array) is required', 'invalid_request_error'));
    }

    if (agentRequest.stream !== true) {
      try {
        const result = await handleRequest(agentRequest, deps);
        return res.json(result.openAiResponse);
      } catch (e) {
        return sendError(res, e, config);
      }
    }

    // ---- streaming: fallback + kiểm tra limit TRƯỚC khi gửi byte đầu (edge case 7) ----
    let handle;
    try {
      handle = await openStream(agentRequest, deps);
    } catch (e) {
      logger.warn(`Stream open failed: ${e.message}`);
      return sendError(res, e, config);
    }
    const { upstream, pair, release } = handle;
    logger.info(`Stream start: key=${pair.key.id} model=${pair.model.name}`);

    let reader;
    try {
      reader = upstream.body.getReader();
    } catch (e) {
      release();
      return sendError(res, e, config);
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const streamId = `chatcmpl-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    let totalTokens = handle.estimated;
    let toolCallIndex = 0; // offset index tool_calls giữa các chunk (OpenAI streaming yêu cầu index tăng dần)
    let streamCompleted = false;
    let clientAborted = false;
    let streamError = null;

    res.on('close', () => {
      if (!res.writableEnded) {
        clientAborted = true; // #2: cancel do disconnect KHÔNG được coi là hoàn tất
        reader.cancel().catch(() => {});
      }
    });

    const handleLine = (line) => {
      const t = line.trim();
      if (!t.startsWith('data:')) return;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      try {
        const g = JSON.parse(payload);
        if (g.usageMetadata && g.usageMetadata.totalTokenCount) totalTokens = g.usageMetadata.totalTokenCount;
        const out = geminiChunkToOpenAiChunk(g, pair.model.name, streamId, created, toolCallIndex);
        toolCallIndex += (out.choices[0] && out.choices[0].delta.tool_calls ? out.choices[0].delta.tool_calls.length : 0);
        res.write(`data: ${JSON.stringify(out)}\n\n`);
      } catch (_) { /* bỏ qua chunk không parse được */ }
    };

    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (clientAborted) break;
        buffer += Buffer.from(value).toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) handleLine(line);
      }
      if (!clientAborted && buffer) handleLine(buffer); // dòng cuối không có '\n'
      streamCompleted = !clientAborted;
    } catch (e) {
      streamError = e;
      logger.error(`Stream interrupted: ${e.message}`);
    }

    release();
    if (streamCompleted) {
      stateStore.recordSuccess(pair.key.id, pair.model.name, totalTokens);
      res.write('data: [DONE]\n\n');
    } else if (streamError && !clientAborted) {
      res.write(`data: ${JSON.stringify(errorToOpenAi(streamError.status || 502, streamError.message))}\n\n`);
    }
    return res.end();
  });

  // JSON hỏng / lỗi body-parser → trả JSON kiểu OpenAI, KHÔNG để Express default handler
  // in HTML stack trace (lộ đường dẫn file nội bộ).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = Number.isInteger(err.status) ? err.status : 500;
    if (status === 400) {
      logger.warn(`Bad request body on ${req.method} ${req.originalUrl}: ${err.message}`);
      return res.status(400).json(errorToOpenAi(400, `Invalid JSON body: ${err.message}`, 'invalid_request_error'));
    }
    logger.error(`Unhandled error on ${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
    return res.status(status).json(errorToOpenAi(status, err.message || 'Internal error'));
  });

  return app;
}

module.exports = { createServer };
