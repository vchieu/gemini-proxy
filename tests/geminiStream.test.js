const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { callGeminiStream, Gemini429Error, GeminiError } = require('../client/geminiClient');

// Mock stream không gửi chunk nào, nhưng PHẢI error khi bị abort (giống undici
// thật) — nếu không thì reader.read() treo vô hạn thay vì reject.
const hangUntilAbort = (signal) => new ReadableStream({
  start(controller) {
    signal.addEventListener('abort', () => {
      controller.error(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    });
  },
});

describe('callGeminiStream (real, mock global.fetch)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns response with ReadableStream body that is async iterable', async () => {
    const sseData = 'data: ' + JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
    }) + '\n\n';

    global.fetch = async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      }),
    });

    const res = await callGeminiStream(
      { api_key: 'k1' },
      { name: 'gemini-2.5-flash' },
      { contents: [] },
      { timeoutMs: 5000 }
    );

    assert.equal(res.status, 200);
    assert.ok(res.body, 'body should exist');
    assert.equal(typeof res.body.getReader, 'function', 'body should have getReader');

    // Verify for await...of works (the regression we fixed)
    let text = '';
    for await (const chunk of res.body) {
      text += Buffer.from(chunk).toString('utf8');
    }
    assert.ok(text.includes('hello'), 'should stream correct text');
  });

  it('throws Gemini429Error on 429 response', async () => {
    global.fetch = async () => ({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({
        error: { message: 'Please retry in 5s', details: [{ retryDelay: '5s' }] },
      }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({
            error: { message: 'Please retry in 5s', details: [{ retryDelay: '5s' }] },
          })));
          controller.close();
        },
      }),
    });

    await assert.rejects(
      () => callGeminiStream({ api_key: 'k1' }, { name: 'm' }, {}, { timeoutMs: 5000 }),
      (e) => e instanceof Gemini429Error && e.retryDelaySeconds === 5
    );
  });

  it('works with a REAL Response (body getter-only) and leaves caller able to getReader', async () => {
    const enc = new TextEncoder();
    global.fetch = async () => new Response(new ReadableStream({
      start(c) { c.enqueue(enc.encode('data: {"a":1}\n\n')); c.close(); },
    }), { status: 200 });
    const res = await callGeminiStream({ api_key: 'k1' }, { name: 'm' }, {}, { timeoutMs: 5000 });
    const reader = res.body.getReader(); // trước fix: TypeError locked
    const { value } = await reader.read();
    assert.ok(Buffer.from(value).toString().includes('"a":1'));
  });

  it('throws GeminiError on 500 response', async () => {
    global.fetch = async () => ({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({
        error: { message: 'Internal error' },
      }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({
            error: { message: 'Internal error' },
          })));
          controller.close();
        },
      }),
    });

    await assert.rejects(
      () => callGeminiStream({ api_key: 'k1' }, { name: 'm' }, {}, { timeoutMs: 5000 }),
      (e) => e.name === 'GeminiError' && e.status === 500
    );
  });

  it('first-byte timeout: upstream không gửi chunk đầu trong firstByteMs -> GeminiError 504 TRƯỚC khi trả stream', async () => {
    // Đây là chỗ timeout TRƯỚC đây không fallback được: openStream trả về ngay khi
    // có header nên tới lúc chunk đầu không tới thì đã quá muộn để chọn cặp khác.
    global.fetch = async (url, init) => ({ ok: true, status: 200, body: hangUntilAbort(init.signal) });

    const t0 = Date.now();
    await assert.rejects(
      () => callGeminiStream({ api_key: 'k1' }, { name: 'm' }, {}, { timeoutMs: 60000, firstByteMs: 150 }),
      (e) => e instanceof GeminiError && e.status === 504 && /first-byte timeout after 150ms/.test(e.message)
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 100 && elapsed < 5000,
      `phải fail theo firstByteMs (~150ms), không được chờ hết timeoutMs 60000ms (thực tế ${elapsed}ms)`);
  });

  it('idle timeout sau chunk đầu: quá timeoutMs mà không có chunk tiếp -> GeminiError 504 idle timeout', async () => {
    global.fetch = async (url, init) => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"a":1}\n\n')); // chunk đầu tới ngay
          init.signal.addEventListener('abort', () => {
            controller.error(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
          });
        },
      }),
    });

    const res = await callGeminiStream({ api_key: 'k1' }, { name: 'm' }, {}, { timeoutMs: 200, firstByteMs: 60000 });
    await assert.rejects(
      async () => { for await (const _chunk of res.body) { /* đọc tới khi stream error */ } },
      (e) => e instanceof GeminiError && e.status === 504 && /idle timeout after 200ms/.test(e.message)
    );
  });
});
