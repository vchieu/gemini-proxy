const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { callOpenAI, callOpenAIStream, Gemini429Error, GeminiError } = require('../client/geminiClient');

const KEY = { id: 'key-1', api_key: 'k1' };
const MODEL = { name: 'gemini-test' };
const OPENAI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

// Dùng Response THẬT: đọc body lần 2 sẽ ném TypeError "Body is unusable".
const jsonRes = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const googleErr = (code, status, message, extra = {}) => ({ error: { code, message, status, ...extra } });

describe('callOpenAI / callOpenAIStream (mock global.fetch, real Response)', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  let captured;

  // Ghi lại (url, init) để assert endpoint + auth + body.
  const captureFetch = (responder) => {
    global.fetch = async (url, init) => {
      captured = { url: String(url), init };
      return responder();
    };
  };

  it('POSTs to the OpenAI-compat endpoint with Bearer auth and overridden model', async () => {
    captureFetch(() => jsonRes(200, { id: 'r1', choices: [] }));
    const out = await callOpenAI(KEY, MODEL, {
      model: 'agent-sent-this', messages: [{ role: 'user', content: 'hi' }],
    });

    assert.equal(captured.url, OPENAI_URL);
    assert.equal(captured.init.headers.Authorization, 'Bearer k1');
    assert.equal(captured.init.headers['Content-Type'], 'application/json');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.model, 'gemini-test', 'model must be replaced by selected pair');
    assert.equal(body.messages[0].content, 'hi', 'messages forwarded verbatim');
    assert.equal('stream_options' in body, false, 'non-stream must drop stream_options');
    assert.equal(out.id, 'r1');
  });

  it('stream: forces stream_options.include_usage and keeps other stream_options fields', async () => {
    captureFetch(() => jsonRes(200, {}));
    await callOpenAIStream(KEY, MODEL, {
      model: 'x', messages: [], stream: true, stream_options: { foo: 'bar' },
    });
    const body = JSON.parse(captured.init.body);
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { foo: 'bar', include_usage: true });
  });

  it('429 object with details[].retryDelay -> Gemini429Error with retryDelaySeconds', async () => {
    captureFetch(() => jsonRes(429, googleErr(429, 429, 'Quota exceeded', {
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }],
    })));
    const e = await callOpenAI(KEY, MODEL, { messages: [] }).catch((x) => x);
    assert.ok(e instanceof Gemini429Error, `expected Gemini429Error, got ${e.name}`);
    assert.equal(e.retryDelaySeconds, 7);
    assert.equal(e.rawMessage, 'Quota exceeded');
  });

  it('429 ARRAY body [{error:{...}}] -> unwrapped, retryDelaySeconds parsed', async () => {
    captureFetch(() => jsonRes(429, [googleErr(429, 429, 'rate limit retry in 5s')]));
    const e = await callOpenAI(KEY, MODEL, { messages: [] }).catch((x) => x);
    assert.ok(e instanceof Gemini429Error, `expected Gemini429Error, got ${e.name}`);
    assert.equal(e.retryDelaySeconds, 5);
    assert.equal(e.rawMessage, 'rate limit retry in 5s', 'array body must be unwrapped to .error.message');
  });

  it('503 ARRAY body -> GeminiError prefixed "Gemini error 503:" with parsed .body', async () => {
    const payload = [googleErr(503, 503, 'The model is overloaded.')];
    captureFetch(() => jsonRes(503, payload));
    const e = await callOpenAI(KEY, MODEL, { messages: [] }).catch((x) => x);
    assert.ok(e instanceof GeminiError, `expected GeminiError, got ${e.name}`);
    assert.ok(/^Gemini error 503:/.test(e.message), `message must carry 5xx prefix, got: ${e.message}`);
    assert.equal(e.status, 503);
    assert.deepEqual(e.body, payload[0], '.body must be the unwrapped JSON object');
  });

  it('403 WITHOUT quota wording -> plain GeminiError (not 429)', async () => {
    captureFetch(() => jsonRes(403, googleErr(403, 403, 'API key not valid.')));
    const e = await callOpenAI(KEY, MODEL, { messages: [] }).catch((x) => x);
    assert.ok(e instanceof GeminiError, `expected GeminiError, got ${e.name}`);
    assert.ok(!(e instanceof Gemini429Error));
    assert.equal(e.status, 403);
  });

  it('403 WITH quota wording -> Gemini429Error', async () => {
    captureFetch(() => jsonRes(403, googleErr(403, 403, 'Quota exceeded for quota metric')));
    const e = await callOpenAI(KEY, MODEL, { messages: [] }).catch((x) => x);
    assert.ok(e instanceof Gemini429Error, `expected Gemini429Error, got ${e.name}`);
    assert.equal(e.status, 429);
  });

  it('callOpenAIStream: HTTP 503 before body -> GeminiError with 5xx prefix', async () => {
    captureFetch(() => jsonRes(503, [googleErr(503, 503, 'overloaded')]));
    const e = await callOpenAIStream(KEY, MODEL, { messages: [], stream: true }).catch((x) => x);
    assert.ok(e instanceof GeminiError, `expected GeminiError, got ${e.name}`);
    assert.ok(/^Gemini error 503:/.test(e.message));
  });

  it('callOpenAIStream: 200 returns { ok, status, body } wrapping a ReadableStream', async () => {
    captureFetch(() => new Response('data: [DONE]\n\n', {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    }));
    const out = await callOpenAIStream(KEY, MODEL, { messages: [], stream: true });
    assert.equal(out.ok, true);
    assert.equal(out.status, 200);
    assert.ok(out.body && typeof out.body.getReader === 'function', 'body must be a ReadableStream');
    const reader = out.body.getReader();
    const { value } = await reader.read();
    assert.ok(new TextDecoder().decode(value).includes('[DONE]'));
  });
});
