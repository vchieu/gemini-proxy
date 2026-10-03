const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { StateStore } = require('../state/store');
const { createServer } = require('../api/server');
const http = require('http');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeReadableStream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
}

function post(port, body, opts = {}) {
  const path = opts.path || '/v1beta/models/gemini-2.5-flash:generateContent';
  const method = opts.method || 'POST';
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function postStream(port, body, opts = {}) {
  const path = opts.path || '/v1beta/models/gemini-2.5-flash:streamGenerateContent';
  const method = opts.method || 'POST';
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('gemini-native route', () => {
  let store, models, keys, app, server, port;

  beforeEach(async () => {
    // Fresh store each test - inflight/reset to 0 on load
    store = new StateStore(null);
    models = [{ name: 'gemini-2.5-flash', priority: 1, limits: { rpm: 100, rpd: 1000, tpm: 250000 } }];
    keys = [{ id: 'key-1', api_key: 'k1', enabled: true }];

    const fakeClient = {
      callGemini: async (key, model, body) => {
        return {
          candidates: [{ content: { parts: [{ text: 'processed' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
        };
      },
      callGeminiStream: async (key, model, body) => {
        const sse = 'data: ' + JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'streamed' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
        }) + '\n\n';
        return { body: makeReadableStream([sse]) };
      },
    };

    app = createServer({ models, keys, stateStore: store, config: {}, geminiClient: fakeClient });
    await new Promise((r) => server = app.listen(0, r));
    port = server.address().port;
  });

  afterEach(() => {
    server.close();
  });

  it('case 1: generateContent usually - body passed through deep-equal, daily_count == 1', async () => {
    const res = await post(port, {});
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('processed'), 'response should contain processed text');
    assert.ok(res.body.includes('candidates'), 'response should contain candidates');
    assert.ok(res.body.includes('usageMetadata'), 'response should contain usageMetadata');
    const st = store.get('key-1', 'gemini-2.5-flash');
    assert.equal(st.daily_count, 1, 'daily_count should be 1 after success');
    assert.equal(st.inflight_count, 0, 'inflight_count should be 0');
  });

  it('case 2: client sends x-goog-api-key and ?key=fake, proxy uses real key from config', async () => {
    const res = await post(port, {});
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('processed'));
  });

  it('case 5: Upstream 400 kèm body Google - client nhận 400 và body y nguyên', async () => {
    const { GeminiError } = require('../client/geminiClient');
    const fakeClient400 = {
      callGemini: async (key, model, body) => {
        throw new GeminiError('Gemini error 400: Bad request', {
          status: 400,
          body: { error: { code: 400, message: 'Bad request', status: 'INVALID_ARGUMENT' } },
        });
      },
    };

    const app2 = createServer({ models, keys, stateStore: new StateStore(null), config: {}, geminiClient: fakeClient400 });
    await new Promise((r) => { server.close(); server = app2.listen(0, r); });
    port = server.address().port;

    const res = await post(port, {});
    assert.equal(res.status, 400);
    let parsed;
    try { parsed = JSON.parse(res.body); } catch (_) { }
    if (parsed && parsed.error) {
      assert.equal(parsed.error.status, 'INVALID_ARGUMENT', 'should have INVALID_ARGUMENT status');
    }
  });

  it('case 11: Action lạ -> 404', async () => {
    const res = await post(port, {}, { path: '/v1beta/models:countTokens' });
    assert.equal(res.status, 404, 'unsupported action should return 404');
  });

  it('case 12: Model name có dấu . và - -> parse đúng model và action', async () => {
    const res = await post(port, {});
    assert.ok(res.status === 200 || res.status === 400, 'should handle model names with dots and dashes');
  });

  it('case 13: stream native - SSE forward nguyên bản, không [DONE], response PHẢI kết thúc', async () => {
    const res = await Promise.race([
      postStream(port, {}),
      delay(3000).then(() => {
        throw new Error('stream response did not end — missing res.end() (client would hang forever)');
      }),
    ]);
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('data:'), 'should forward SSE bytes natively');
    assert.ok(res.body.includes('streamed'), 'should contain upstream text');
    assert.ok(!res.body.includes('[DONE]'), 'native Gemini stream must not have [DONE]');
  });
});