const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { StateStore } = require('../state/store');
const { createServer } = require('../api/server');
const { Gemini429Error } = require('../client/geminiClient');
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

  it('holds tool_call chunk until thoughtSignature arrives in a LATER chunk', async () => {
    const store = new StateStore(null);
    const models = [{ name: 'm', priority: 1, limits: { rpm: 100, rpd: 1000, tpm: 1000000 } }];
    const keys = [{ id: 'key-1', api_key: 'k1', enabled: true }];
    const SIG = 'late-sig+99/==';

    // 3 payload: functionCall (không sig) -> orphan thoughtSignature -> finish
    const p1 = 'data: ' + JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: 'read', args: { path: 'a' } } }] }, finishReason: 'STOP' }],
    }) + '\n\n';
    const p2 = 'data: ' + JSON.stringify({
      candidates: [{ content: { parts: [{ thoughtSignature: SIG }] } }],
    }) + '\n\n';
    const p3 = 'data: ' + JSON.stringify({
      candidates: [{ content: { parts: [] } }, { content: { parts: [] } }],
    }) + '\n\n';

    const fakeClient = {
      callGeminiStream: async () => ({ body: makeReadableStream([p1, p2, p3]) }),
    };

    const app = createServer({ models, keys, stateStore: store, config: {}, geminiClient: fakeClient });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;

    try {
      const res = await post(port, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(res.status, 200);
      const tcLine = res.body.split('\n').find((l) => l.includes('tool_calls'));
      assert.ok(tcLine, 'phải có chunk tool_calls');
      const tc = JSON.parse(tcLine.slice(5)).choices[0].delta.tool_calls[0];
      assert.ok(tc.id.startsWith('callsig_'), 'sig đến chunk sau vẫn phải gán vào id');
      assert.ok(tc.id.endsWith(`_${SIG}`));
      // thứ tự: tool_calls TRƯỚC [DONE]
      assert.ok(res.body.indexOf('tool_calls') < res.body.indexOf('[DONE]'));
      assert.ok(res.body.includes('[DONE]'));
      assert.equal(store.get('key-1', 'm').daily_count, 1, 'stream hoàn tất -> recordSuccess');
    } finally {
      server.close();
    }
  });

  it('joins multi-line data: fields per SSE spec (event ends at blank line)', async () => {
    const store = new StateStore(null);
    const models = [{ name: 'm', priority: 1, limits: { rpm: 100, rpd: 1000, tpm: 1000000 } }];
    const keys = [{ id: 'key-1', api_key: 'k1', enabled: true }];

    // payload JSON bị tách thành 2 dòng data: (SSE spec: gộp với '\n')
    const payload = JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'multiline-ok' }] }, finishReason: 'STOP' }],
    });
    const half = Math.floor(payload.length / 2);
    const sse = `data: ${payload.slice(0, half)}\ndata: ${payload.slice(half)}\n\n`;

    const fakeClient = {
      callGeminiStream: async () => ({ body: makeReadableStream([sse]) }),
    };

    const app = createServer({ models, keys, stateStore: store, config: {}, geminiClient: fakeClient });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;

    try {
      const res = await post(port, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('multiline-ok'), 'phải gộp multi-line data: rồi parse được');
      assert.ok(res.body.includes('[DONE]'));
      assert.equal(store.get('key-1', 'm').daily_count, 1, 'stream hoàn tất -> recordSuccess');
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

  it('falls back to next pair on upstream 429 before opening stream', async () => {
    const store = new StateStore(null);
    const models = [
      { name: 'a', priority: 1, limits: { rpm: 100, rpd: 1000, tpm: 1e6 } },
      { name: 'b', priority: 2, limits: { rpm: 100, rpd: 1000, tpm: 1e6 } },
    ];
    const keys = [{ id: 'key-1', api_key: 'k1', enabled: true }];
    const sse = 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }] }) + '\n\n';
    const fakeClient = {
      callGeminiStream: async (key, model) => {
        if (model.name === 'a') throw new Gemini429Error('retry in 5s', { retryDelaySeconds: 5 });
        return { body: makeSSEBody(sse) };
      },
    };
    const app = createServer({ models, keys, stateStore: store, config: {}, geminiClient: fakeClient });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const res = await post(server.address().port, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('hello') && res.body.includes('[DONE]'));
      assert.ok(store.get('key-1', 'a').cooldown_until > Date.now());
      assert.equal(store.get('key-1', 'b').daily_count, 1);
    } finally { server.close(); }
  });

  it('does NOT recordSuccess/[DONE] when client disconnects mid-stream, and releases slot', async () => {
    const store = new StateStore(null);
    const models = [{ name: 'm', priority: 1, limits: { rpm: 100, rpd: 1000, tpm: 1e6 } }];
    const keys = [{ id: 'key-1', api_key: 'k1', enabled: true }];
    const enc = new TextEncoder();
    let cancelled = false;
    const infinite = new ReadableStream({
      pull(c) {
        return new Promise((r) => setTimeout(() => {
          try {
            c.enqueue(enc.encode('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }) + '\n\n'));
          } catch (_) { /* controller đã đóng sau cancel */ }
          r();
        }, 20));
      },
      cancel() { cancelled = true; },
    });
    const fakeClient = { callGeminiStream: async () => ({ body: infinite }) };
    const app = createServer({ models, keys, stateStore: store, config: {}, geminiClient: fakeClient });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    try {
      const data = JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      await new Promise((resolve) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
          (res) => { res.on('error', () => {}); res.once('data', () => { req.destroy(); resolve(); }); });
        req.on('error', () => {});
        req.write(data); req.end();
      });
      await delay(150);
      const st = store.get('key-1', 'm');
      assert.equal(st.daily_count, 0);
      assert.equal(st.inflight_count, 0);
      assert.equal(cancelled, true);
    } finally { server.close(); }
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
