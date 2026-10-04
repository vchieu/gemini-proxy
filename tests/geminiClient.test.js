const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const geminiClient = require('../client/geminiClient');
const { callGemini, callGeminiStream, Gemini429Error, GeminiError } = geminiClient;
const { StateStore } = require('../state/store');
const { handleRequest } = require('../router/fallbackLoop');
const { _resetRoundRobin } = require('../router/selector');

const KEY = { id: 'key-1', api_key: 'k1' };
const MODEL = { name: 'gemini-test' };

// Dùng Response THẬT (không phải object giả): đọc body lần 2 sẽ ném
// TypeError "Body is unusable" — đúng cái bug cần chặn regression.
const jsonRes = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const textRes = (status, text) => new Response(text, { status });

const googleErr = (code, status, message, extra = {}) => ({ error: { code, message, status, ...extra } });

describe('callGemini error handling (mock global.fetch, real Response)', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('200 -> trả body đã parse', async () => {
    global.fetch = async () => jsonRes(200, { candidates: [], usageMetadata: { totalTokenCount: 8 } });
    const body = await callGemini(KEY, MODEL, {});
    assert.equal(body.usageMetadata.totalTokenCount, 8);
  });

  it('503 -> GeminiError (không phải TypeError), message có prefix "Gemini error 503:", body Google được giữ', async () => {
    const g = googleErr(503, 'UNAVAILABLE', 'This model is currently experiencing high demand.');
    global.fetch = async () => jsonRes(503, g);
    await assert.rejects(
      () => callGemini(KEY, MODEL, {}),
      (e) => {
        assert.ok(e instanceof GeminiError, `expected GeminiError, got ${e.name}: ${e.message}`);
        assert.equal(e.status, 503);
        assert.ok(e.message.startsWith('Gemini error 503:'));
        assert.ok(e.message.includes('high demand'));
        assert.deepEqual(e.body, g);
        return true;
      }
    );
  });

  it('400 kèm body Google -> GeminiError giữ nguyên body (native router trả lại cho client)', async () => {
    const g = googleErr(400, 'INVALID_ARGUMENT', 'Bad request');
    global.fetch = async () => jsonRes(400, g);
    await assert.rejects(
      () => callGemini(KEY, MODEL, {}),
      (e) => e instanceof GeminiError && e.status === 400 && e.body.error.status === 'INVALID_ARGUMENT'
    );
  });

  it('500 body không phải JSON -> GeminiError, body undefined, message chứa text gốc', async () => {
    global.fetch = async () => textRes(500, '<html>oops</html>');
    await assert.rejects(
      () => callGemini(KEY, MODEL, {}),
      (e) => e instanceof GeminiError && e.status === 500 && e.body === undefined && e.message.includes('<html>oops</html>')
    );
  });

  it('429 -> Gemini429Error với retryDelaySeconds từ details', async () => {
    global.fetch = async () => jsonRes(429, googleErr(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded',
      { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }] }));
    await assert.rejects(
      () => callGemini(KEY, MODEL, {}),
      (e) => e instanceof Gemini429Error && e.status === 429 && e.retryDelaySeconds === 7
    );
  });

  it('403 kèm quota message -> Gemini429Error', async () => {
    global.fetch = async () => jsonRes(403, googleErr(403, 'PERMISSION_DENIED', 'Quota exceeded. Please retry in 12s.'));
    await assert.rejects(
      () => callGemini(KEY, MODEL, {}),
      (e) => e instanceof Gemini429Error && e.status === 429 && e.retryDelaySeconds === 12
    );
  });

  it('403 KHÔNG phải quota -> GeminiError 403 (regression: trước đây TypeError do đọc body 2 lần)', async () => {
    global.fetch = async () => jsonRes(403, googleErr(403, 'PERMISSION_DENIED', 'API key not valid for this method'));
    await assert.rejects(
      () => callGemini(KEY, MODEL, {}),
      (e) => {
        assert.ok(e instanceof GeminiError, `expected GeminiError, got ${e.name}: ${e.message}`);
        assert.equal(e.status, 403);
        assert.equal(e.body.error.status, 'PERMISSION_DENIED');
        return true;
      }
    );
  });
});

describe('callGeminiStream error handling (mock global.fetch, real Response)', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('503 -> GeminiError "Gemini error 503:" với body Google', async () => {
    const g = googleErr(503, 'UNAVAILABLE', 'high demand');
    global.fetch = async () => jsonRes(503, g);
    await assert.rejects(
      () => callGeminiStream(KEY, MODEL, {}),
      (e) => e instanceof GeminiError && e.status === 503 && e.message.startsWith('Gemini error 503:') && e.body.error.status === 'UNAVAILABLE'
    );
  });

  it('403 KHÔNG phải quota -> GeminiError 403 (regression: trước đây TypeError do đọc body 2 lần)', async () => {
    global.fetch = async () => jsonRes(403, googleErr(403, 'PERMISSION_DENIED', 'API key not valid'));
    await assert.rejects(
      () => callGeminiStream(KEY, MODEL, {}),
      (e) => {
        assert.ok(e instanceof GeminiError, `expected GeminiError, got ${e.name}: ${e.message}`);
        assert.equal(e.status, 403);
        assert.equal(e.body.error.status, 'PERMISSION_DENIED');
        return true;
      }
    );
  });

  it('403 kèm quota message -> Gemini429Error', async () => {
    global.fetch = async () => jsonRes(403, googleErr(403, 'PERMISSION_DENIED', 'Rate limit hit. Please retry in 9s.'));
    await assert.rejects(
      () => callGeminiStream(KEY, MODEL, {}),
      (e) => e instanceof Gemini429Error && e.retryDelaySeconds === 9
    );
  });

  it('400 -> GeminiError giữ body Google đã parse (không bọc giả)', async () => {
    const g = googleErr(400, 'INVALID_ARGUMENT', 'Bad request');
    global.fetch = async () => jsonRes(400, g);
    await assert.rejects(
      () => callGeminiStream(KEY, MODEL, {}),
      (e) => e instanceof GeminiError && e.status === 400 && JSON.stringify(e.body) === JSON.stringify(g)
    );
  });
});

describe('fallback 5xx non-stream với geminiClient THẬT (mock fetch)', () => {
  const originalFetch = global.fetch;
  beforeEach(() => _resetRoundRobin());
  afterEach(() => { global.fetch = originalFetch; });

  it('503 trên model A -> fallback model B, không cooldown, không tính quota cho A', async () => {
    const store = new StateStore(null);
    const models = [
      { name: 'model-a', priority: 1, limits: { rpm: 5, rpd: 20, tpm: 250000 } },
      { name: 'model-b', priority: 2, limits: { rpm: 5, rpd: 20, tpm: 250000 } },
    ];
    const keys = [{ id: 'key-1', api_key: 'k1', enabled: true }];
    const calledModels = [];
    global.fetch = async (url) => {
      const m = /models\/([^:]+):/.exec(String(url))[1];
      calledModels.push(m);
      if (m === 'model-a') return jsonRes(503, googleErr(503, 'UNAVAILABLE', 'high demand'));
      return jsonRes(200, {
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      });
    };
    const result = await handleRequest(
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      { models, keys, stateStore: store, geminiClient, config: { upstream_mode: 'translate', max_fallback_attempts: 6, request_timeout_ms: 5000, default_cooldown_seconds: 30 } }
    );
    assert.deepEqual(calledModels, ['model-a', 'model-b']);
    assert.equal(result.usedModel, 'model-b');
    assert.equal(result.openAiResponse.choices[0].message.content, 'ok');
    const a = store.get('key-1', 'model-a');
    assert.equal(a.daily_count, 0);
    assert.ok(!(a.cooldown_until > Date.now()));
    assert.equal(a.inflight_count, 0);
  });
});
