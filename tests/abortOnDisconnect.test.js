const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { StateStore } = require('../state/store');
const { createServer } = require('../api/server');
const { handleRequest } = require('../router/fallbackLoop');
const geminiClient = require('../client/geminiClient');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const MODELS = [{ name: 'm', priority: 1, limits: { rpm: 100, rpd: 1000, tpm: 1000000 } }];
const KEYS = [{ id: 'key-1', api_key: 'k1', enabled: true }];

describe('non-stream client disconnect -> aborts upstream (Low: giữ reservation tới timeout 60s)', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('client ngắt giữa chừng -> upstream fetch bị abort, reservation được trả lại, không recordSuccess', async () => {
    const store = new StateStore(null);
    let upstreamAborted = false;
    // Mock fetch treo vô hạn tới khi signal abort — đúng hành vi upstream chậm
    global.fetch = async (url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => {
        upstreamAborted = true;
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });

    const app = createServer({ models: MODELS, keys: KEYS, stateStore: store, config: {}, geminiClient });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    try {
      const data = JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
      await new Promise((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        });
        req.on('error', () => {});
        req.write(data);
        req.end();
        // Ngắt kết nối sau khi request đã đi lên (upstream đang treo)
        setTimeout(() => { req.destroy(); resolve(); }, 100);
      });
      await delay(200); // thời gian để abort lan sang upstream

      assert.equal(upstreamAborted, true, 'upstream fetch PHẢI bị abort khi client ngắt (không giữ tới timeout 60s)');
      const st = store.get('key-1', 'm');
      assert.equal(st.inflight_count, 0, 'reservation phải được trả lại');
      assert.equal(st.daily_count, 0, 'không recordSuccess');
    } finally {
      server.close();
    }
  });

  it('handleRequest ném lỗi 499 (client aborted) — non-429/non-5xx, không fallback, không cooldown', async () => {
    const store = new StateStore(null);
    let calls = 0;
    const aborter = new AbortController();
    const deps = {
      models: MODELS, keys: KEYS, stateStore: store,
      config: { upstream_mode: 'openai_compat', max_fallback_attempts: 6, request_timeout_ms: 5000, default_cooldown_seconds: 30 },
      geminiClient: {
        callOpenAI: async (key, model, body, options) => {
          calls += 1;
          // Mô phỏng client abort đúng lúc upstream đang gọi
          return new Promise((_, reject) => {
            options.signal.addEventListener('abort', () => {
              reject(new geminiClient.GeminiError('Upstream request aborted (client disconnected)', { status: 499 }));
            });
            aborter.abort();
          });
        },
      },
    };

    const e = await handleRequest(
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      deps,
      { signal: aborter.signal }
    ).catch((x) => x);

    assert.equal(e.status, 499, 'phải là lỗi 499 (client aborted)');
    assert.equal(calls, 1, '499 KHÔNG được fallback sang cặp khác');
    const st = store.get('key-1', 'm');
    assert.equal(st.inflight_count, 0, 'reservation phải được trả lại');
    assert.ok(!(st.cooldown_until > Date.now()), '499 KHÔNG được set cooldown');
    assert.equal(st.daily_count, 0, '499 KHÔNG được tính quota');
  });

  it('callGemini với signal đã aborted sẵn -> ném 499 ngay (không gửi request)', async () => {
    let fetched = false;
    // Mô phỏng đúng hành vi fetch thật: signal đã aborted -> reject AbortError ngay
    global.fetch = async (url, opts) => {
      if (opts.signal.aborted) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      fetched = true;
      return new Response('{}');
    };
    const aborter = new AbortController();
    aborter.abort();
    const e = await geminiClient.callGemini(
      KEYS[0], { name: 'm' }, {}, { signal: aborter.signal }
    ).catch((x) => x);
    assert.equal(e.status, 499, 'signal aborted sẵn -> 499');
    await delay(10);
    assert.equal(fetched, false, 'không được gửi fetch khi signal đã aborted');
  });
});
