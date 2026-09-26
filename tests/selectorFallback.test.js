const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { StateStore } = require('../state/store');
const { selectPair, _resetRoundRobin } = require('../router/selector');
const { handleRequest } = require('../router/fallbackLoop');
const { Gemini429Error } = require('../client/geminiClient');

function makeModels() {
  return [
    { name: 'gemini-2.5-flash', priority: 1, limits: { rpm: 5, rpd: 20, tpm: 250000 } },
    { name: 'gemini-2.5-flash-lite', priority: 2, limits: { rpm: 15, rpd: 200, tpm: 250000 } },
  ];
}
function makeKeys() {
  return [
    { id: 'key-1', api_key: 'k1', enabled: true },
    { id: 'key-2', api_key: 'k2', enabled: true },
  ];
}

describe('selector', () => {
  beforeEach(() => _resetRoundRobin());
  it('prefers priority model first', () => {
    const store = new StateStore(null);
    const p = selectPair(makeModels(), makeKeys(), store, Date.now(), 100, []);
    assert.equal(p.model.name, 'gemini-2.5-flash');
  });
  it('skips exhausted model, falls to next priority', () => {
    const store = new StateStore(null);
    const now = Date.now();
    // cày hết RPM của model 1 trên cả 2 key
    for (const k of ['key-1', 'key-2']) {
      const st = store.get(k, 'gemini-2.5-flash');
      st.request_timestamps = [now - 1000, now - 2000, now - 3000, now - 4000, now - 5000];
    }
    const p = selectPair(makeModels(), makeKeys(), store, now, 100, []);
    assert.equal(p.model.name, 'gemini-2.5-flash-lite');
  });
  it('round-robins keys', () => {
    const store = new StateStore(null);
    const models = [{ name: 'm', priority: 1, limits: { rpm: 100, rpd: 1000, tpm: 1e9 } }];
    const a = selectPair(models, makeKeys(), store, Date.now(), 10, []);
    const b = selectPair(models, makeKeys(), store, Date.now(), 10, []);
    assert.notEqual(a.key.id, b.key.id);
  });
  it('returns null when all exhausted', () => {
    const store = new StateStore(null);
    const now = Date.now();
    for (const m of makeModels()) for (const k of ['key-1', 'key-2']) {
      store.setCooldown(k, m.name, now + 60000);
    }
    assert.equal(selectPair(makeModels(), makeKeys(), store, now, 10, []), null);
  });
});

describe('fallbackLoop integration (mock 429 -> fallback)', () => {
  beforeEach(() => _resetRoundRobin());
  it('falls back from model A to model B on 429', async () => {
    const store = new StateStore(null);
    const models = makeModels();
    const keys = [{ id: 'key-1', api_key: 'k1', enabled: true }];
    let calls = 0;
    const fakeClient = {
      callGemini: async (key, model) => {
        calls++;
        if (model.name === 'gemini-2.5-flash') {
          throw new Gemini429Error('Please retry in 5s', { rawMessage: 'Please retry in 5s', retryDelaySeconds: 5 });
        }
        return { candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } };
      },
    };
    const result = await handleRequest(
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      { models, keys, stateStore: store, geminiClient: fakeClient, config: { max_fallback_attempts: 6, request_timeout_ms: 5000, default_cooldown_seconds: 30 } }
    );
    assert.equal(result.usedModel, 'gemini-2.5-flash-lite');
    assert.equal(result.openAiResponse.choices[0].message.content, 'hello');
    assert.equal(calls, 2);
    // cặp fail phải bị cooldown
    assert.ok(store.get('key-1', 'gemini-2.5-flash').cooldown_until > Date.now());
  });

  it('throws aggregated 429 when everything is limited', async () => {
    const store = new StateStore(null);
    const now = Date.now();
    const models = makeModels();
    const keys = makeKeys();
    for (const m of models) for (const k of keys) store.setCooldown(k.id, m.name, now + 20000);
    const fakeClient = { callGemini: async () => { throw new Error('should not be called'); } };
    await assert.rejects(
      () => handleRequest({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }, { models, keys, stateStore: store, geminiClient: fakeClient, config: { max_fallback_attempts: 4, default_cooldown_seconds: 30 } }),
      (e) => e.status === 429
    );
  });
});
