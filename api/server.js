const express = require('express');
const { handleRequest, Aggregated429Error } = require('../router/fallbackLoop');
const { selectAndReserve } = require('../router/selector');
const { openAiToGemini, geminiChunkToOpenAiChunk } = require('./translate');
const { estimateTokens } = require('../utils/tokenEstimate');
const { extractRetryDelaySeconds } = require('../client/errorParser');
const { Gemini429Error } = require('../client/geminiClient');
const { logger } = require('../utils/logger');

function errorToOpenAi(status, message, code) {
  return { error: { message, type: code || (status === 429 ? 'rate_limit_exceeded' : 'api_error'), code: String(status) } };
}

/**
 * Khởi tạo Express app với 3 route chính:
 *  POST /v1/chat/completions
 *  GET  /v1/models
 *  GET  /admin/status
 * @param {{models, keys, stateStore, config, geminiClient?}} deps
 * @returns {import('express').Express}
 */
function createServer({ models, keys, stateStore, config, geminiClient }) {
  const client = geminiClient || require('../client/geminiClient');
  const app = express();
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
    const stream = agentRequest.stream === true;

    if (!stream) {
      try {
        const result = await handleRequest(agentRequest, { models, keys, stateStore, geminiClient: client, config });
        return res.json(result.openAiResponse);
      } catch (e) {
        if (e instanceof Aggregated429Error || e.status === 429) {
          const retryAfter = e.retryAfterSeconds || config.default_cooldown_seconds || 30;
          res.set('Retry-After', String(retryAfter));
          return res.status(429).json(errorToOpenAi(429, e.message));
        }
        const status = e.status && Number.isInteger(e.status) ? e.status : 500;
        return res.status(status).json(errorToOpenAi(status, e.message || 'Internal error'));
      }
    }

    // ---- streaming: kiểm tra rate-limit TRƯỚC khi stream (edge case 7) ----
    // releaseStreamSlot: trả chỗ đã giữ nếu có lỗi xảy ra ngoài các nhánh trong.
    let releaseStreamSlot = null;
    try {
      let candidateModels = models;
      if (config.respect_agent_model && agentRequest.model && agentRequest.model !== 'auto') {
        const found = models.filter((m) => m.name === agentRequest.model);
        if (found.length > 0) candidateModels = found;
      }
      const estimated = estimateTokens(agentRequest.messages);
      const pair = selectAndReserve(candidateModels, keys, stateStore, Date.now(), estimated, []);
      if (!pair) {
        res.set('Retry-After', String(config.default_cooldown_seconds || 30));
        return res.status(429).json(errorToOpenAi(429, 'Tất cả model/key đều đang bị giới hạn'));
      }
      // Mọi đường thoát phía dưới phải release chỗ đã giữ.
      let released = false;
      const releaseOnce = () => {
        if (!released) {
          released = true;
          stateStore.release(pair.key.id, pair.model.name, estimated);
        }
      };
      releaseStreamSlot = releaseOnce;
      const geminiBody = openAiToGemini(agentRequest);
      logger.info(`Stream start: key=${pair.key.id} model=${pair.model.name}`);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const streamId = `chatcmpl-${Date.now().toString(36)}`;
      const created = Math.floor(Date.now() / 1000);
      let totalTokens = estimated;

      let upstream;
      try {
        upstream = await client.callGeminiStream(pair.key, pair.model, geminiBody, {
          timeoutMs: config.request_timeout_ms,
        });
      } catch (e) {
        if (e instanceof Gemini429Error || e.status === 429) {
          const retrySeconds = e.retryDelaySeconds || extractRetryDelaySeconds({ error: { message: e.message } });
          releaseOnce();
          stateStore.setCooldown(pair.key.id, pair.model.name, Date.now() + retrySeconds * 1000 + 500);
          if (!res.headersSent) {
            res.set('Retry-After', String(Math.ceil(retrySeconds)));
            return res.status(429).json(errorToOpenAi(429, e.message));
          }
          res.write(`data: ${JSON.stringify(errorToOpenAi(429, e.message))}\n\n`);
          return res.end();
        }
        releaseOnce();
        throw e;
      }

      // Gemini streamGenerateContent?alt=sse trả về các dòng "data: {...}"
      let buffer = '';
      try {
        for await (const chunk of upstream.body) {
          buffer += Buffer.from(chunk).toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const payload = t.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const g = JSON.parse(payload);
              if (g.usageMetadata && g.usageMetadata.totalTokenCount) totalTokens = g.usageMetadata.totalTokenCount;
              const oai = geminiChunkToOpenAiChunk(g, pair.model.name, streamId, created);
              res.write(`data: ${JSON.stringify(oai)}\n\n`);
            } catch (_) {
              // bỏ qua chunk không parse được
            }
          }
        }
      } catch (e) {
        logger.error(`Stream interrupted: ${e.message}`);
      }
      releaseOnce();
      stateStore.recordSuccess(pair.key.id, pair.model.name, totalTokens);
      res.write('data: [DONE]\n\n');
      return res.end();
    } catch (e) {
      if (releaseStreamSlot) releaseStreamSlot();
      logger.error(`Stream setup failed: ${e.message}`);
      if (!res.headersSent) {
        const status = e.status || 500;
        return res.status(status).json(errorToOpenAi(status, e.message));
      }
      try { res.end(); } catch (_) {}
    }
  });

  return app;
}

module.exports = { createServer };
