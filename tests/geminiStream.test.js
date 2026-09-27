const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { callGeminiStream, Gemini429Error } = require('../client/geminiClient');

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
});
