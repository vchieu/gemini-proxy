const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { StateStore } = require('../state/store');
const { _resetRoundRobin } = require('../router/selector');
const { handleRequest, openStream, Aggregated429Error } = require('../router/fallbackLoop');
const { Gemini429Error, GeminiError } = require('../client/geminiClient');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const MODELS = [
  { name: 'a', priority: 1, limits: { rpm: 100, rpd: 1000, tpm: 1000000 } },
  { name: 'b', priority: 2, limits: { rpm: 100, rpd: 1000, tpm: 1000000 } },
];
const KEYS = [{ id: 'key-1', api_key: 'k1', enabled: true }];

const OPENAI_OK = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
};

function makeDeps(extra = {}) {
  const stateStore = new StateStore(null);
  return {
    stateStore,
    models: MODELS,
    keys: KEYS,
    config: {
      upstream_mode: 'openai_compat',
      max_fallback_attempts: 6,
      request_timeout_ms: 5000,
      default_cooldown_seconds: 30,
      ...(extra.config || {}),
    },
    ...(extra.client ? { geminiClient: extra.client } : {}),
  };
}

const req = { model: 'auto', messages: [{ role: 'user', content: 'hi' }] };

describe('fallbackLoop upstream_mode=openai_compat', () => {
  beforeEach(() => _resetRoundRobin());

  it('calls callOpenAI (not callGemini) and returns the Google payload untouched', async () => {
    const calls = [];
    const deps = makeDeps({ client: {
      callGemini: async () => { throw new Error('callGemini must NOT be used in openai_compat'); },
      callOpenAI: async (key, model, body) => {
        calls.push({ keyId: key.id, model: model.name, body });
        return OPENAI_OK;
      },
    } });

    const out = await handleRequest(req, deps);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'a');
    assert.equal(calls[0].body.model, 'auto', 'body forwarded as-is (model override happens in client)');
    assert.deepEqual(out.openAiResponse, OPENAI_OK, 'response returned verbatim, NOT via geminiToOpenAi');
    assert.equal(out.usedModel, 'a');
    assert.equal(out.attempts, 1);
  });

  it('records usage.total_tokens (not usageMetadata) and releases the reservation', async () => {
    const deps = makeDeps({ client: { callOpenAI: async () => OPENAI_OK } });
    await handleRequest(req, deps);

    const st = deps.stateStore.get('key-1', 'a');
    assert.equal(st.daily_count, 1);
    const tokensUsed = (st.token_timestamps || []).reduce((s, e) => s + (e[1] || 0), 0);
    assert.equal(tokensUsed, 8, 'usage.total_tokens must drive quota');
    assert.equal(st.inflight_count, 0, 'reservation released after success');
    assert.equal(st.inflight_tokens, 0);
  });

  it('skips openAiToGemini entirely (raw OpenAI body reaches the client)', async () => {
    const deps = makeDeps({ client: {
      // Nếu withFallback vẫn dịch format thì ctx.geminiBody sẽ khác undefined
      // và callOpenAI sẽ nhận body Gemini -> bắt lỗi tại đây.
      callOpenAI: async (key, model, body) => {
        assert.ok(Array.isArray(body.messages), 'body must still be OpenAI messages[]');
        assert.equal(body.contents, undefined, 'body must NOT be Gemini contents[]');
        return OPENAI_OK;
      },
    } });
    await handleRequest(req, deps);
  });

  it('429 on model a -> cooldown + fallback to model b', async () => {
    let calls = 0;
    const deps = makeDeps({ client: {
      callOpenAI: async (key, model) => {
        calls += 1;
        if (model.name === 'a') throw new Gemini429Error('retry in 5s', { retryDelaySeconds: 5 });
        return OPENAI_OK;
      },
    } });

    const out = await handleRequest(req, deps);

    assert.equal(calls, 2);
    assert.equal(out.usedModel, 'b');
    assert.equal(out.attempts, 2);
    const a = deps.stateStore.get('key-1', 'a');
    assert.ok(a.cooldown_until > Date.now(), 'model a must be cooling down');
    assert.equal(a.daily_count, 0, 'failed attempt must not count quota');
    assert.equal(deps.stateStore.get('key-1', 'b').daily_count, 1);
  });

  it('503 on model a -> fallback to b with NO cooldown and NO quota on a', async () => {
    let calls = 0;
    const deps = makeDeps({ client: {
      callOpenAI: async (key, model) => {
        calls += 1;
        if (model.name === 'a') throw new GeminiError('Gemini error 503: The model is overloaded.', { status: 503, body: {} });
        return OPENAI_OK;
      },
    } });

    const out = await handleRequest(req, deps);

    assert.equal(calls, 2, '5xx must fall back to the next pair');
    assert.equal(out.usedModel, 'b');
    const a = deps.stateStore.get('key-1', 'a');
    assert.ok(!a.cooldown_until, '5xx must NOT set cooldown');
    assert.equal(a.daily_count, 0, '5xx must NOT count quota');
    assert.equal(a.inflight_count, 0, 'reservation released on error path');
  });

  it('non-429 non-5xx error (400) -> returned immediately, no fallback', async () => {
    let calls = 0;
    const deps = makeDeps({ client: {
      callOpenAI: async () => { calls += 1; throw new GeminiError('Gemini error 400: bad request', { status: 400 }); },
    } });

    const e = await handleRequest(req, deps).catch((x) => x);
    assert.equal(calls, 1, '400 must not retry');
    assert.equal(e.status, 400);
    assert.equal(deps.stateStore.get('key-1', 'a').inflight_count, 0, 'reservation released on throw');
  });

  it('all pairs 429 -> Aggregated429Error (429) with Retry-After', async () => {
    const deps = makeDeps({ client: {
      callOpenAI: async () => { throw new Gemini429Error('retry in 9s', { retryDelaySeconds: 9 }); },
    } });

    const e = await handleRequest(req, deps).catch((x) => x);
    assert.ok(e instanceof Aggregated429Error, `expected Aggregated429Error, got ${e.name}`);
    assert.equal(e.status, 429);
    // retryDelay 9s + pad 500ms của setCooldown -> ceil(9.5s) = 10s
    assert.ok(e.retryAfterSeconds >= 9, `Retry-After must cover retryDelay, got ${e.retryAfterSeconds}`);
  });

  it('all pairs 5xx -> the original 5xx upstream error (not a 429)', async () => {
    const deps = makeDeps({ client: {
      callOpenAI: async () => { throw new GeminiError('Gemini error 503: overloaded', { status: 503, body: {} }); },
    } });

    const e = await handleRequest(req, deps).catch((x) => x);
    assert.ok(e instanceof GeminiError, `expected the 5xx GeminiError, got ${e.name}`);
    assert.equal(e.status, 503);
  });

  it('concurrent requests at rpm=1 -> exactly 1 upstream call, 2 aggregated 429', async () => {
    const { StateStore } = require('../state/store');
    const models = [{ name: 'm', priority: 1, limits: { rpm: 1, rpd: 10, tpm: 100000 } }];
    let upstreamCalls = 0;
    const deps = {
      models, keys: KEYS, stateStore: new StateStore(null),
      config: { upstream_mode: 'openai_compat', max_fallback_attempts: 2, request_timeout_ms: 5000, default_cooldown_seconds: 30 },
      geminiClient: { callOpenAI: async () => { upstreamCalls += 1; await delay(80); return OPENAI_OK; } },
    };
    const one = () => handleRequest(req, deps);
    const results = await Promise.allSettled([one(), one(), one()]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const limited = results.filter((r) => r.status === 'rejected' && r.reason && r.reason.status === 429);
    assert.equal(ok.length, 1, `expected 1 success, got ${ok.length}`);
    assert.equal(limited.length, 2, `expected 2 aggregated-429, got ${limited.length}`);
    assert.equal(upstreamCalls, 1, `expected 1 upstream call, got ${upstreamCalls}`);
  });

  it('translate mode does NOT call callOpenAI', async () => {
    const deps = makeDeps({ config: { upstream_mode: 'translate' }, client: {
      callOpenAI: async () => { throw new Error('callOpenAI must NOT be used in translate mode'); },
      callGemini: async () => ({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { totalTokenCount: 8 },
      }),
    } });
    const out = await handleRequest(req, deps);
    assert.equal(out.openAiResponse.choices[0].message.content, 'ok', 'translated via geminiToOpenAi');
  });

  it('openStream uses callOpenAIStream and its release() is idempotent', async () => {
    const deps = makeDeps({ client: {
      callOpenAIStream: async () => ({ ok: true, status: 200, body: 'stream-body' }),
    } });
    const h = await openStream(req, deps);
    assert.equal(h.upstream.body, 'stream-body');
    assert.equal(deps.stateStore.get('key-1', 'a').inflight_count, 1, 'reserved while stream open');

    h.release();
    h.release(); // idempotent — không được trừ 2 lần
    const st = deps.stateStore.get('key-1', 'a');
    assert.equal(st.inflight_count, 0);
    assert.equal(st.inflight_tokens, 0);
    assert.equal(st.daily_count, 0, 'openStream never records success');
  });
});
