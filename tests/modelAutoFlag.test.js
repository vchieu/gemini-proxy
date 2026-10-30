const test = require('node:test');
const assert = require('node:assert');
const { handleRequest, Aggregated429Error } = require('../router/fallbackLoop');
const { StateStore } = require('../state/store');
const { _resetRoundRobin } = require('../router/selector');

const LIMITS = { rpm: 1000, rpd: 100000, tpm: 10000000 };

function makeDeps() {
  const models = [
    { name: 'm-flash', priority: 1, limits: LIMITS },
    { name: 'm-lite', priority: 2, auto: false, limits: LIMITS },
  ];
  const keys = [
    { id: 'k1', api_key: 'x1', enabled: true },
    { id: 'k2', api_key: 'x2', enabled: true },
  ];
  const calls = [];
  const geminiClient = {
    callOpenAI: async (key, model) => {
      calls.push({ key: key.id, model: model.name });
      return {
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { total_tokens: 5 },
      };
    },
  };
  const config = { upstream_mode: 'openai_compat', respect_agent_model: true, strategy: 'round_robin_key_then_model' };
  const stateStore = new StateStore();
  return { models, keys, stateStore, geminiClient, config, calls };
}

const req = (model) => ({ model, messages: [{ role: 'user', content: 'hi' }] });

test('auto / gemini-auto / không chỉ định model: KHÔNG bao giờ chọn model auto:false', async () => {
  for (const model of ['auto', 'gemini-auto', undefined]) {
    _resetRoundRobin();
    const deps = makeDeps();
    for (let i = 0; i < 6; i++) await handleRequest(req(model), deps);
    assert.ok(deps.calls.length === 6);
    assert.ok(deps.calls.every((c) => c.model === 'm-flash'), `model=${model}`);
  }
});

test('chỉ định đích danh model auto:false: chọn đúng nó và xoay cả 2 key', async () => {
  _resetRoundRobin();
  const deps = makeDeps();
  for (let i = 0; i < 4; i++) await handleRequest(req('m-lite'), deps);
  assert.ok(deps.calls.every((c) => c.model === 'm-lite'));
  assert.deepStrictEqual(new Set(deps.calls.map((c) => c.key)), new Set(['k1', 'k2']));
});

test('auto: hết quota/cooldown mọi model auto -> 429, KHÔNG rơi sang model auto:false', async () => {
  _resetRoundRobin();
  const deps = makeDeps();
  const until = Date.now() + 60000;
  for (const k of deps.keys) deps.stateStore.setCooldown(k.id, 'm-flash', until);
  await assert.rejects(() => handleRequest(req('auto'), deps), (e) => e instanceof Aggregated429Error);
  assert.strictEqual(deps.calls.length, 0);
});
