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

describe('persist resilience (Windows EPERM: file bị antivirus/instance khác giữ lúc rename)', () => {
  const eperm = (msg) => {
    const e = new Error(msg || "EPERM: operation not permitted, rename 'x.state.json.tmp' -> 'x.state.json'");
    e.code = 'EPERM';
    return e;
  };

  it('retry sau rename fail 1 lần -> ghi thành công đồng bộ, không sót tmp', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-state-'));
    const file = path.join(dir, 'state.json');
    try {
      const store = new StateStore(file);
      store.get('key-1', 'm').daily_count = 7; // mutate trực tiếp để không schedule debounce timer
      const origRename = fs.renameSync;
      let failedOnce = false;
      fs.renameSync = (...args) => {
        if (!failedOnce) { failedOnce = true; throw eperm(); }
        return origRename(...args);
      };
      try {
        assert.equal(store.persist(), true, 'persist phải thành công sau retry');
      } finally {
        fs.renameSync = origRename;
      }
      assert.ok(failedOnce, 'rename fail 1 lần trước khi retry');
      const reloaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(reloaded.pairs['key-1::m'].daily_count, 7);
      assert.ok(!fs.existsSync(`${file}.${process.pid}.tmp`), 'tmp đã được rename, không sót lại');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fail đủ 3 attempt -> không ném, WARN 1 lần, tmp còn; lần persist sau self-heal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-state-'));
    const file = path.join(dir, 'state.json');
    const warns = [];
    const origWarn = console.warn;
    const origRename = fs.renameSync;
    let ok = false;
    try {
      const store = new StateStore(file);
      store.get('key-1', 'm').daily_count = 3;
      fs.renameSync = () => { throw eperm(); };
      console.warn = (m) => warns.push(String(m));
      try {
        ok = store.persist();
      } finally {
        fs.renameSync = origRename;
        console.warn = origWarn;
        // huỷ safety-net timer để nó không bắn vào giữa các test sau
        if (store._retryTimer) { clearTimeout(store._retryTimer); store._retryTimer = null; }
      }
      assert.equal(ok, false, 'persist trả false khi bỏ cuộc');
      assert.ok(warns.some((w) => w.includes('persist failed after 3 attempts')),
        `phải WARN đúng 1 lần về 3 attempt thất bại, got: ${JSON.stringify(warns)}`);
      assert.ok(!fs.existsSync(file), 'state.json chưa được tạo do rename fail hết');
      assert.ok(fs.existsSync(`${file}.${process.pid}.tmp`), 'tmp nằm lại sau khi rename fail');
      // bỏ patch -> lần persist kế tiếp ghi lại bình thường (coi như hết lock)
      assert.equal(store.persist(), true, 'self-heal ở lần persist kế');
      assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).pairs['key-1::m'].daily_count === 3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('constructor dọn tmp cũ (state.json.tmp legacy + state.json.<pid>.tmp)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-state-'));
    const file = path.join(dir, 'state.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ pairs: { 'k::m': { daily_count: 3 } } }));
      const legacyTmp = `${file}.tmp`;
      const pidTmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(legacyTmp, '{"garbage":');
      fs.writeFileSync(pidTmp, '{"garbage":');
      const store = new StateStore(file);
      assert.ok(!fs.existsSync(legacyTmp), 'tmp legacy bị dọn lúc load');
      assert.ok(!fs.existsSync(pidTmp), 'tmp theo pid bị dọn lúc load');
      assert.equal(store.get('k', 'm').daily_count, 3, 'state.json cũ vẫn load bình thường');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('safety-net: sau khi fail đủ 3 attempt, retry tự động sau ~1s ghi được khi hết lock', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-state-'));
    const file = path.join(dir, 'state.json');
    const origWarn = console.warn;
    const origRename = fs.renameSync;
    try {
      const store = new StateStore(file);
      store.get('key-1', 'm').daily_count = 9;
      fs.renameSync = () => { throw eperm(); };
      console.warn = () => {}; // nuốt WARN dự kiến trong lúc test
      let ok;
      try {
        ok = store.persist();
      } finally {
        fs.renameSync = origRename; // "hết lock" trước khi safety-net bắn
        console.warn = origWarn;
      }
      assert.equal(ok, false);
      assert.ok(store._retryTimer, 'safety-net timer phải được xếp');
      await delay(1300);
      assert.ok(fs.existsSync(file), 'safety-net retry sau 1s phải ghi thành công');
      assert.equal(store._retryTimer, null, 'timer đã tự huỷ sau khi chạy');
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pairs['key-1::m'].daily_count, 9);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
