const express = require('express');
const { handleRequest, openStream, Aggregated429Error } = require('../router/fallbackLoop');
const { streamOpenAiPassthrough } = require('./openaiPassthrough');
const { geminiChunkToOpenAiChunk, attachThoughtSignature } = require('./translate');
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
  // Mặc định openai_compat (khớp config/loader.js); `config:{}` trong test vẫn
  // đi nhánh này — test nào muốn luyện nhánh legacy phải ghi rõ upstream_mode.
  const upstreamMode = (config && config.upstream_mode) || 'openai_compat';
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

  // Che key= trong originalUrl access log de bao mat api key tu client (?key=... hoac x-goog-api-key)
  app.use((req, res, next) => {
    if (req.originalUrl) {
      req.originalUrl = req.originalUrl.replace(/([?&]key=)[^&]*/i, '$1***');
    }
    next();
  });

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
    res.json({ now, strategy: config.strategy, upstream_mode: upstreamMode, pairs });
  });

  // Mount Gemini-native router at /v1beta
  // - POST /v1beta/models/:modelAction (generateContent, streamGenerateContent)
  // - GET /v1beta/models (danh sách model)
  // Routes at /v1 are reserved for OpenAI-compatible endpoints only.
  const { createGeminiNativeRouter } = require('./geminiNative');
  const nativeRouter = createGeminiNativeRouter(deps);
  app.use('/v1beta', nativeRouter);

  app.post('/v1/chat/completions', async (req, res) => {
    const agentRequest = req.body || {};
    if (!Array.isArray(agentRequest.messages)) {
      return res.status(400).json(errorToOpenAi(400, 'Field "messages" (array) is required', 'invalid_request_error'));
    }

    if (agentRequest.stream !== true) {
      try {
        const result = await handleRequest(agentRequest, deps);
        // tool_call không có thoughtSignature -> id ở format cũ, replay history Gemini 3 sẽ 400.
        // Hai mode đều nhúng sig vào id (translate: geminiToOpenAi; openai_compat: signatureShim)
        // nên điều kiện chỉ cần là "id không bắt đầu bằng callsig_".
        const tcs = result.openAiResponse?.choices?.[0]?.message?.tool_calls;
        if (Array.isArray(tcs)) {
          const bad = tcs.filter((t) => !String(t.id || '').startsWith('callsig_'));
          if (bad.length > 0) {
            logger.warn(`Response có ${bad.length} tool_call KHÔNG kèm thoughtSignature — replay history sẽ 400 với Gemini 3`, {
              ids: bad.map((t) => t.id),
              model: result.usedModel,
              key: result.usedKeyId,
            });
          }
        }
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

    // openai_compat: passthrough SSE ở mức event (không defer thoughtSignature —
    // signature do Google endpoint tự lo, xem PLAN-openai-compat-migration.md Phase 4)
    if (upstreamMode === 'openai_compat') {
      return streamOpenAiPassthrough({ req, res, handle, agentRequest, deps, sendError, errorToOpenAi });
    }

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

    // thoughtSignature đôi khi đến Ở CHUNK/PART SAU khi functionCall (test live:
    // ~1/20 call bị lỡ -> id cũ không sig -> replay 400). Trì hoãn ghi ra client:
    // giữ chunk tới khi sig về gán vào, hoặc tới cuối stream nếu sig không bao
    // giờ đến (plan §4.5). Kèm diagnostic để điều tra khi sig "mất tích".
    const deferred = []; // chunk object đang giữ (giữ nguyên thứ tự)
    const pendingSigs = []; // orphan thoughtSignature chưa gán (đến trước/alongside call)
    const toolCallsOf = (out) => (out && out.choices && out.choices[0] && out.choices[0].delta && out.choices[0].delta.tool_calls) || [];
    const isSigless = (tc) => !String(tc.id || '').startsWith('callsig_');
    const anySigless = () => deferred.some((d) => toolCallsOf(d).some(isSigless));
    const writeChunk = (out) => res.write(`data: ${JSON.stringify(out)}\n\n`);
    // Diagnostic: đếm + giữ raw payload (cắt ngắn) các chunk liên quan, chỉ dump
    // khi cuối stream vẫn còn call thiếu sig -> WARN chi tiết để điều tra.
    const diag = { events: 0, fcParts: 0, sigParts: 0, orphanSigs: 0, unparseable: 0, fcRaw: [], sigRaw: [] };
    const rememberRaw = (arr, payload) => {
      if (arr.length < 10) arr.push(payload.length > 1500 ? payload.slice(0, 1500) + '…(trunc)' : payload);
    };
    const flushDeferred = () => {
      if (anySigless()) {
        const ids = deferred.flatMap((d) => toolCallsOf(d)).filter(isSigless).map((tc) => tc.id);
        logger.warn(`Stream: ${ids.length} tool_call phát ra KHÔNG có thoughtSignature — replay history sẽ 400 với Gemini 3`, {
          ids,
          model: pair.model.name,
          key: pair.key.id,
          events: diag.events,
          fcParts: diag.fcParts,
          sigParts: diag.sigParts,
          orphanSigs: diag.orphanSigs,
          unparseableEvents: diag.unparseable,
          leftoverSigs: pendingSigs.length,
          fcRaw: diag.fcRaw,
          sigRaw: diag.sigRaw,
        });
      }
      while (deferred.length) writeChunk(deferred.shift());
    };
    const attachPending = (out) => {
      // gán pendingSigs vào call thiếu sig CŨ NHẤT trước (deferred trước, current sau)
      for (const d of deferred) {
        for (const tc of toolCallsOf(d)) {
          if (isSigless(tc) && pendingSigs.length) tc.id = attachThoughtSignature(tc.id, pendingSigs.shift());
        }
      }
      for (const tc of toolCallsOf(out)) {
        if (isSigless(tc) && pendingSigs.length) tc.id = attachThoughtSignature(tc.id, pendingSigs.shift());
      }
    };

    res.on('close', () => {
      if (!res.writableEnded) {
        clientAborted = true; // #2: cancel do disconnect KHÔNG được coi là hoàn tất
        reader.cancel().catch(() => {});
      }
    });

    // Chuẩn hóa thoughtSignature: API trả string, nhưng phòng shape object
    // ({signature: ...}) -> lấy field string bên trong; không nhận được -> null.
    const normalizeSig = (v) => {
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object') {
        for (const k of ['signature', 'value', 'sig', 'thoughtSignature']) {
          if (typeof v[k] === 'string') return v[k];
        }
      }
      return null;
    };

    const processEvent = (payload) => {
      if (!payload || payload === '[DONE]') return;
      let g;
      try {
        g = JSON.parse(payload);
      } catch (_) {
        diag.unparseable++;
        logger.warn(`Stream: chunk SSE không parse được (bỏ qua)`, { payload: payload.slice(0, 500) });
        return;
      }
      diag.events++;
      if (g.usageMetadata && g.usageMetadata.totalTokenCount) totalTokens = g.usageMetadata.totalTokenCount;
      const parts = (g.candidates && g.candidates[0] && g.candidates[0].content && g.candidates[0].content.parts) || [];
      const orphanSigs = [];
      let siglessCalls = 0;
      for (const p of parts) {
        // phát hiện shape lạ: field chứa "thought"/"sign" mà không phải thoughtSignature
        for (const k of Object.keys(p)) {
          if (k !== 'thoughtSignature' && /thought|sign/i.test(k)) {
            logger.warn(`Stream: part có field bất thường "${k}" (shape thoughtSignature có thể đổi)`, { keys: Object.keys(p) });
          }
        }
        if (p.functionCall) {
          diag.fcParts++;
          if (p.thoughtSignature === undefined) {
            siglessCalls++;
            rememberRaw(diag.fcRaw, payload); // chunk chứa call chưa có sig — bằng chứng nếu sig không về
          }
        }
        if (p.thoughtSignature !== undefined) {
          diag.sigParts++;
          const sig = normalizeSig(p.thoughtSignature);
          if (!sig) {
            logger.warn(`Stream: thoughtSignature không phải string (không gắn được)`, { value: JSON.stringify(p.thoughtSignature).slice(0, 500) });
          } else if (!p.functionCall) {
            diag.orphanSigs++;
            orphanSigs.push(sig);
            rememberRaw(diag.sigRaw, payload);
          }
        }
      }
      const out = geminiChunkToOpenAiChunk(g, pair.model.name, streamId, created, toolCallIndex);
      toolCallIndex += toolCallsOf(out).length;

      // same-chunk pairing đã làm trong extractToolCalls (min(siglessCalls, orphanSigs)),
      // phần orphan dư lại -> pending
      for (let i = Math.min(siglessCalls, orphanSigs.length); i < orphanSigs.length; i++) {
        pendingSigs.push(orphanSigs[i]);
      }
      attachPending(out);

      const outSigless = toolCallsOf(out).some(isSigless);
      if (outSigless || deferred.length > 0) {
        deferred.push(out); // giữ thứ tự: không ghi chunk mới khi còn chunk cũ đang defer
        if (!anySigless()) flushDeferred(); // sig vừa về đã gán hết -> xả ngay
        return;
      }
      writeChunk(out);
    };

    // SSE đúng spec: 1 event = nhiều dòng `data:` (gộp lại, phân tách '\n'),
    // kết thúc bởi dòng trống. Các field khác (event:/id:/retry:) và comment (:) bỏ qua.
    let dataLines = [];
    const handleLine = (line) => {
      const l = line.replace(/\r$/, '');
      if (l === '') {
        if (dataLines.length > 0) {
          processEvent(dataLines.join('\n'));
          dataLines = [];
        }
        return;
      }
      if (l.startsWith('data:')) dataLines.push(l.slice(5).replace(/^ /, ''));
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
      if (!clientAborted && dataLines.length > 0) processEvent(dataLines.join('\n')); // event cuối thiếu dòng trống
      dataLines = [];
      streamCompleted = !clientAborted;
    } catch (e) {
      streamError = e;
      logger.error(`Stream interrupted: ${e.message}`);
    }

    release();
    if (streamCompleted) {
      flushDeferred(); // xả phần trì hoãn TRƯỚC [DONE] (kể cả khi sig không đến — đã warn)
      stateStore.recordSuccess(pair.key.id, pair.model.name, totalTokens);
      res.write('data: [DONE]\n\n');
    } else if (streamError && !clientAborted) {
      deferred.length = 0; // stream lỗi -> bỏ phần giữ lệnh, chỉ báo lỗi
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
