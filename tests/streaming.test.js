const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { StateStore } = require('../state/store');
const { createServer } = require('../api/server');
const http = require('http');

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

function makeSSEBody(text) {
  return makeReadableStream([text]);
}

function post(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
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

describe('streaming route (ReadableStream body)', () => {
  it('forwards SSE chunks and writes [DONE] on clean finish', async () => {
    const store = new StateStore(null);
    const models = [{ name: 'm', priority: 1, limits: { rpm: 100, rpd: 1000, tpm: 1000000 } }];
    const keys = [{ id: 'key-1', api_key: 'k1', enabled: true }];

    const sseData = 'data: ' + JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
    }) + '\n\n';

    const fakeClient = {
      callGeminiStream: async () => ({ body: makeSSEBody(sseData) }),
    };

    const app = createServer({ models, keys, stateStore: store, config: {}, geminiClient: fakeClient });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;

    try {
      const res = await post(port, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('data:'), 'should contain SSE data');
      assert.ok(res.body.includes('hello'), 'should forward chunk text');
      assert.ok(res.body.includes('[DONE]'), 'should write [DONE] on clean finish');
      // recordSuccess phải được gọi (stream hoàn tất)
      const st = store.get('key-1', 'm');
      assert.equal(st.daily_count, 1);
    } finally {
      server.close();
    }
  });

  it('does NOT write [DONE] or recordSuccess when stream is interrupted', async () => {
    const store = new StateStore(null);
    const models = [{ name: 'm', priority: 1, limits: { rpm: 100, rpd: 1000, tpm: 1000000 } }];
    const keys = [{ id: 'key-1', api_key: 'k1', enabled: true }];

    // Stream tự ném lỗi giữa chừng
    const errorStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'STOP' }],
        }) + '\n\n'));
        controller.error(new Error('network reset'));
      },
    });

    const fakeClient = {
      callGeminiStream: async () => ({ body: errorStream }),
    };

    const app = createServer({ models, keys, stateStore: store, config: {}, geminiClient: fakeClient });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;

    try {
      const res = await post(port, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(res.status, 200);
      // Quan trọng: KHÔNG [DONE] và KHÔNG recordSuccess khi stream bị interrupt
      assert.ok(!res.body.includes('[DONE]'), 'should NOT write [DONE] on interrupt');
      const st = store.get('key-1', 'm');
      assert.equal(st.daily_count, 0);
    } finally {
      server.close();
    }
  });

  it('returns 429 when all pairs exhausted', async () => {
    const store = new StateStore(null);
    const now = Date.now();
    const models = [{ name: 'm', priority: 1, limits: { rpm: 1, rpd: 100, tpm: 1000000 } }];
    const keys = [{ id: 'key-1', api_key: 'k1', enabled: true }];
    // Cày hết RPM
    const st = store.get('key-1', 'm');
    st.request_timestamps = [now - 1000];

    const app = createServer({ models, keys, stateStore: store, config: {} });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;

    try {
      const res = await post(port, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(res.status, 429);
    } finally {
      server.close();
    }
  });
});
