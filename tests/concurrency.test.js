const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateStore } = require('../state/store');
const { selectPair, selectAndReserve, _resetRoundRobin } = require('../router/selector');
const { handleRequest } = require('../router/fallbackLoop');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function onePairSetup() {
  return {
    models: [{ name: 'm', priority: 1, limits: { rpm: 1, rpd: 10, tpm: 100000 } }],
    keys: [{ id: 'key-1', api_key: 'k1', enabled: true }],
  };
}

describe('inflight reservation (edge case #3: concurrent requests)', () => {
  beforeEach(() => _resetRoundRobin());

  it('reserve blocks a second select at rpm=1 until release', () => {
    const { models, keys } = onePairSetup();
    const store = new StateStore(null);
    const first = selectAndReserve(models, keys, store, Date.now(), 10, []);
    assert.ok(first, 'first select should succeed');
    assert.equal(selectPair(models, keys, store, Date.now(), 10, []), null);
    store.release(first.key.id, first.model.name, 10);
    assert.ok(selectPair(models, keys, store, Date.now(), 10, []), 'available again after release');
  });

  it('inflight tokens count toward TPM', () => {
    const store = new StateStore(null);
    const models = [{ name: 'm', priority: 1, limits: { rpm: 100, rpd: 1000, tpm: 1000 } }];
    const keys = [{ id: 'key-1', api_key: 'k1', enabled: true }];
    const first = selectAndReserve(models, keys, store, Date.now(), 900, []);
    assert.ok(first);
    // 900 inflight + 200 estimated > 1000 -> unavailable
    assert.equal(selectPair(models, keys, store, Date.now(), 200, []), null);
    // 900 inflight + 100 estimated <= 1000 -> available
    assert.ok(selectPair(models, keys, store, Date.now(), 100, []));
  });

  it('concurrent handleRequest calls do not overshoot rpm=1', async () => {
    const { models, keys } = onePairSetup();
    const store = new StateStore(null);
    let upstreamCalls = 0;
    const fakeClient = {
      callGemini: async () => {
        upstreamCalls++;
        await delay(100); // giữ slot mở để lộ race nếu không có reservation
        return {
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
        };
      },
    };
    const deps = {
      models, keys, stateStore: store, geminiClient: fakeClient,
      config: { upstream_mode: 'translate', max_fallback_attempts: 2, request_timeout_ms: 5000, default_cooldown_seconds: 30 },
    };
    const req = () => handleRequest({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }, deps);
    const results = await Promise.allSettled([req(), req(), req()]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const limited = results.filter((r) => r.status === 'rejected' && r.reason && r.reason.status === 429);
    assert.equal(ok.length, 1, `expected exactly 1 success, got ${ok.length}`);
    assert.equal(limited.length, 2, `expected 2 aggregated-429, got ${limited.length}`);
    assert.equal(upstreamCalls, 1, `expected 1 upstream call, got ${upstreamCalls}`);
  });

  it('persist strips inflight state (transient, must not survive restart)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-state-'));
    const file = path.join(dir, 'state.json');
    const store = new StateStore(file);
    store.reserve('key-1', 'm', 500);
    store.persist();
    const reloaded = new StateStore(file);
    const st = reloaded.get('key-1', 'm');
    assert.equal(st.inflight_count || 0, 0);
    assert.equal(st.inflight_tokens || 0, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
