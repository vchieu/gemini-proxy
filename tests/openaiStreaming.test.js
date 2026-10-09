const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { StateStore } = require('../state/store');
const { createServer } = require('../api/server');
const { Gemini429Error, GeminiError } = require('../client/geminiClient');
const http = require('http');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const MODELS = [
  { name: 'a', priority: 1, limits: { rpm: 100, rpd: 1000, tpm: 1000000 } },
  { name: 'b', priority: 2, limits: { rpm: 100, rpd: 1000, tpm: 1000000 } },
];
const KEYS = [{ id: 'key-1', api_key: 'k1', enabled: true }];

// Đếm occurrences — dùng để bắt bug ghi [DONE] 2 lần.
const countOf = (hay, needle) => hay.split(needle).length - 1;

function makeReadableStream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

// Stream nhận Uint8Array THÔ (không qua string) — cần cho test UTF-8 split (H1),
// vì encode(decode(half)) sẽ tự làm hỏng byte đa-byte ngay trong test.
function makeRawStream(byteChunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of byteChunks) controller.enqueue(chunk);
      controller.close();
    },
  });
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

function makeApp(store, client, models = MODELS) {
  const app = createServer({
    models, keys: KEYS, stateStore: store,
    config: { upstream_mode: 'openai_compat' },
    geminiClient: client,
  });
  const server = app.listen(0);
  return new Promise((r) => server.once('listening', () => r(server)));
}

const chatChunk = (id, text, extra = {}) => ({
  id,
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  ...extra,
});

describe('streamOpenAiPassthrough (upstream_mode=openai_compat)', () => {
  it('forwards chunks and writes exactly one [DONE] on clean finish', async () => {
    const store = new StateStore(null);
    const sse =
      'data: ' + JSON.stringify(chatChunk('c1', 'hello', { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })) + '\n\n' +
      'data: [DONE]\n\n';
    const server = await makeApp(store, {
      callOpenAIStream: async () => ({ ok: true, status: 200, body: makeReadableStream([sse]) }),
    });
    try {
      const res = await post(server.address().port, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('hello'), 'chunk forwarded');
      assert.equal(countOf(res.body, '[DONE]'), 1, 'exactly one [DONE]');
      const st = store.get('key-1', 'a');
      assert.equal(st.daily_count, 1, 'clean finish -> recordSuccess');
      assert.equal(st.inflight_count, 0, 'released');
      const tokens = (st.token_timestamps || []).reduce((s, e) => s + (e[1] || 0), 0);
      assert.equal(tokens, 8, 'usage.total_tokens recorded');
    } finally { server.close(); }
  });

  it('appends [DONE] when upstream never sends one', async () => {
    const store = new StateStore(null);
    const sse = 'data: ' + JSON.stringify(chatChunk('c1', 'hi')) + '\n\n';
    const server = await makeApp(store, {
      callOpenAIStream: async () => ({ ok: true, status: 200, body: makeReadableStream([sse]) }),
    });
    try {
      const res = await post(server.address().port, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(countOf(res.body, '[DONE]'), 1, 'proxy must append exactly one [DONE]');
      assert.equal(store.get('key-1', 'a').daily_count, 1);
    } finally { server.close(); }
  });

  it('forwards the RAW payload (no parse->stringify roundtrip)', async () => {
    const store = new StateStore(null);
    // Khoảng trắng + thứ tự field giữ nguyên nếu KHÔNG stringify lại.
    const rawPayload = '{"choices": [ {"index": 0, "delta": {"content": "raw-kept"} } ],"zz_marker":"KEEP"}';
    const sse = `data: ${rawPayload}\n\n` + 'data: [DONE]\n\n';
    const server = await makeApp(store, {
      callOpenAIStream: async () => ({ ok: true, status: 200, body: makeReadableStream([sse]) }),
    });
    try {
      const res = await post(server.address().port, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.ok(res.body.includes(rawPayload), 'payload must be forwarded verbatim');
      assert.ok(res.body.includes('raw-kept'));
    } finally { server.close(); }
  });

  it('joins multi-line data: fields per SSE spec', async () => {
    const store = new StateStore(null);
    const payload = JSON.stringify(chatChunk('c1', 'multiline-ok'));
    const half = Math.floor(payload.length / 2);
    const sse = `data: ${payload.slice(0, half)}\ndata: ${payload.slice(half)}\n\n` + 'data: [DONE]\n\n';
    const server = await makeApp(store, {
      callOpenAIStream: async () => ({ ok: true, status: 200, body: makeReadableStream([sse]) }),
    });
    try {
      const res = await post(server.address().port, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.ok(res.body.includes('multiline-ok'), 'multi-line data: must be joined then forwarded');
      assert.equal(countOf(res.body, '[DONE]'), 1);
    } finally { server.close(); }
  });

  it('filters usage-only chunk (choices:[]) when agent did NOT ask for include_usage', async () => {
    const store = new StateStore(null);
    const sse =
      'data: ' + JSON.stringify(chatChunk('c1', 'text')) + '\n\n' +
      'data: ' + JSON.stringify({ id: 'usage-only-marker', choices: [], usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 42 } }) + '\n\n' +
      'data: [DONE]\n\n';
    const server = await makeApp(store, {
      callOpenAIStream: async () => ({ ok: true, status: 200, body: makeReadableStream([sse]) }),
    });
    try {
      const res = await post(server.address().port, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.ok(res.body.includes('text'), 'real chunk forwarded');
      assert.ok(!res.body.includes('usage-only-marker'), 'usage-only chunk must be dropped');
      const st = store.get('key-1', 'a');
      const tokens = (st.token_timestamps || []).reduce((s, e) => s + (e[1] || 0), 0);
      assert.equal(tokens, 42, 'usage captured even when the chunk itself is filtered');
    } finally { server.close(); }
  });

  it('forwards usage-only chunk when agent DID ask stream_options.include_usage', async () => {
    const store = new StateStore(null);
    const sse =
      'data: ' + JSON.stringify({ id: 'usage-only-marker', choices: [], usage: { total_tokens: 42 } }) + '\n\n' +
      'data: [DONE]\n\n';
    const server = await makeApp(store, {
      callOpenAIStream: async () => ({ ok: true, status: 200, body: makeReadableStream([sse]) }),
    });
    try {
      const res = await post(server.address().port, {
        model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }],
        stream_options: { include_usage: true },
      });
      assert.ok(res.body.includes('usage-only-marker'), 'agent asked for usage -> must be forwarded');
    } finally { server.close(); }
  });

  it('Case B stream: tool_call chunk mang thought_signature -> callsig_ id + index điền vào (plan 4.4)', async () => {
    const store = new StateStore(null);
    const SIG = 'SIG_STREAM_CASE_B';
    const toolChunk = (tc) => JSON.stringify({
      id: 'c1', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [tc] }, finish_reason: null }],
    });
    // Google KHÔNG gửi `index` trên delta tool_calls (L6: sawIndex=false) và gửi sig
    // ở delta riêng — mô phỏng đúng hành vi đã quan sát.
    const sse =
      'data: ' + toolChunk({ id: 'callg_1', type: 'function', function: { name: 'get_weather', arguments: '' } }) + '\n\n' +
      'data: ' + toolChunk({ function: { arguments: '{"city":"Paris"}' } }) + '\n\n' +
      'data: ' + toolChunk({ extra_content: { google: { thought_signature: SIG } } }) + '\n\n' +
      'data: ' + JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n' +
      'data: [DONE]\n\n';
    const server = await makeApp(store, {
      callOpenAIStream: async () => ({ ok: true, status: 200, body: makeReadableStream([sse]) }),
    });
    try {
      const res = await post(server.address().port, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(res.status, 200);

      const events = res.body.split('\n\n')
        .map((s) => s.replace(/^data: /, ''))
        .filter((s) => s && s !== '[DONE]')
        .map((s) => JSON.parse(s));
      const tcDeltas = events
        .flatMap((p) => (p.choices || []).map((c) => c.delta || {}))
        .filter((d) => Array.isArray(d.tool_calls))
        .flatMap((d) => d.tool_calls);

      assert.ok(tcDeltas.length >= 3, `expected the tool_call deltas, got ${tcDeltas.length}`);
      assert.ok(tcDeltas.every((tc) => typeof tc.index === 'number'),
        `every tool_call delta must carry a numeric index, got ${JSON.stringify(tcDeltas.map((t) => t.index))}`);
      assert.deepEqual(tcDeltas.map((t) => t.index), [0, 0, 0],
        'continuation deltas must stay on the same index');

      const lastWithId = tcDeltas.filter((t) => typeof t.id === 'string').pop();
      assert.ok(lastWithId.id.startsWith('callsig_'), `id must carry the signature, got ${lastWithId.id}`);
      assert.ok(lastWithId.id.endsWith(`_${SIG}`), 'signature must round-trip through the id');
      assert.ok(tcDeltas.every((t) => !('extra_content' in t)),
        'client must never see extra_content (it drops the field anyway)');
      assert.ok(!res.body.includes('extra_content'), 'payload forwarded must not contain extra_content');
    } finally { server.close(); }
  });

  it('mid-stream error -> NO [DONE], NO recordSuccess, reservation released', async () => {
    const store = new StateStore(null);
    const errorStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(chatChunk('c1', 'partial')) + '\n\n'));
        controller.error(new Error('network reset'));
      },
    });
    const server = await makeApp(store, {
      callOpenAIStream: async () => ({ ok: true, status: 200, body: errorStream }),
    });
    try {
      const res = await post(server.address().port, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(res.status, 200);
      assert.ok(!res.body.includes('[DONE]'), 'interrupted stream must NOT get [DONE]');
      const st = store.get('key-1', 'a');
      assert.equal(st.daily_count, 0, 'must NOT recordSuccess');
      assert.equal(st.inflight_count, 0, 'reservation must be released');
    } finally { server.close(); }
  });

  it('mid-stream in-band error chunk -> forwards error, NO [DONE], NO recordSuccess, releases reservation (H2)', async () => {
    const store = new StateStore(null);
    const inBandErr = 'data: {"error":{"code":429,"message":"Resource exhausted: quota exceeded"}}\n\n';
    let upstreamCancelled = false; // M6: reader PHẢI được cancel sau in-band error
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(chatChunk('c1', 'partial')) + '\n\n'));
        controller.enqueue(new TextEncoder().encode(inBandErr));
      },
      cancel() { upstreamCancelled = true; },
    });
    const server = await makeApp(store, {
      callOpenAIStream: async () => ({ ok: true, status: 200, body }),
    });
    try {
      const res = await post(server.address().port, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('Resource exhausted'), 'error chunk must be forwarded');
      assert.ok(!res.body.includes('[DONE]'), 'must NOT append [DONE] after error');
      const st = store.get('key-1', 'a');
      assert.equal(st.daily_count, 0, 'must NOT recordSuccess');
      assert.equal(st.inflight_count, 0, 'reservation must be released');
      assert.ok(st.cooldown_until > Date.now(), 'in-band 429 must set cooldown (M2) — nếu không request sau chọn lại đúng cặp cạn quota');
      assert.equal(upstreamCancelled, true, 'upstream reader must be cancelled after in-band error (M6)');
    } finally { server.close(); }
  });

  it('in-band 429 "per day" -> cooldown tới daily_reset_at, không phải 30s (M3)', async () => {
    const store = new StateStore(null);
    const inBandErr = 'data: ' + JSON.stringify({
      error: { code: 429, message: "Quota exceeded for quota metric 'GenerateContent requests per day' and limit 'GenerateContent requests per day'" },
    }) + '\n\n';
    const server = await makeApp(store, {
      callOpenAIStream: async () => ({ ok: true, status: 200, body: makeReadableStream([inBandErr]) }),
    });
    try {
      const res = await post(server.address().port, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(res.status, 200);
      const st = store.get('key-1', 'a');
      assert.equal(st.cooldown_until, st.daily_reset_at, 'daily quota -> cooldown phải là daily_reset_at (nửa đêm PT)');
    } finally { server.close(); }
  });

  it('decodes UTF-8 multi-byte char split giữa 2 network chunk (H1) — không được ra U+FFFD', async () => {
    const store = new StateStore(null);
    const text = 'Xin chào thế giới 🌍 — emoji + CJK: 漢字重慶';
    const sse = 'data: ' + JSON.stringify(chatChunk('c1', text)) + '\n\ndata: [DONE]\n\n';
    const bytes = new TextEncoder().encode(sse);
    // Cắt NGAY SAU byte đầu tiên của 1 ký tự đa-byte (byte >= 0x80) — đúng cửa sổ
    // từng làm hỏng Unicode khi decode từng chunk network riêng lẻ.
    const cut = bytes.findIndex((b) => b >= 0x80) + 1;
    assert.ok(cut > 0 && cut < bytes.length, 'test premise: phải cắt được giữa 1 ký tự UTF-8');
    const server = await makeApp(store, {
      callOpenAIStream: async () => ({ ok: true, status: 200, body: makeRawStream([bytes.slice(0, cut), bytes.slice(cut)]) }),
    });
    try {
      const res = await post(server.address().port, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(res.status, 200);
      assert.ok(res.body.includes(text), `payload must be forwarded intact, got: ${res.body.slice(0, 300)}`);
      assert.ok(!res.body.includes('\uFFFD'), 'no replacement characters — multi-byte char must survive the chunk split');
      assert.equal(countOf(res.body, '[DONE]'), 1);
    } finally { server.close(); }
  });

  it('client disconnect -> no recordSuccess, upstream cancelled, reservation released', async () => {
    const store = new StateStore(null);
    const enc = new TextEncoder();
    let cancelled = false;
    const infinite = new ReadableStream({
      pull(c) {
        return new Promise((r) => setTimeout(() => {
          try { c.enqueue(enc.encode('data: ' + JSON.stringify(chatChunk('c1', 'x')) + '\n\n')); }
          catch (_) { /* đã cancel */ }
          r();
        }, 20));
      },
      cancel() { cancelled = true; },
    });
    const server = await makeApp(store, { callOpenAIStream: async () => ({ ok: true, status: 200, body: infinite }) });
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
      const st = store.get('key-1', 'a');
      assert.equal(st.daily_count, 0, 'no recordSuccess after client abort');
      assert.equal(st.inflight_count, 0, 'released after client abort');
      assert.equal(cancelled, true, 'upstream reader must be cancelled');
    } finally { server.close(); }
  });

  it('falls back to the next pair on upstream 429 before the first byte', async () => {
    const store = new StateStore(null);
    const sse = 'data: ' + JSON.stringify(chatChunk('c1', 'fallback-ok')) + '\n\ndata: [DONE]\n\n';
    const server = await makeApp(store, {
      callOpenAIStream: async (key, model) => {
        if (model.name === 'a') throw new Gemini429Error('retry in 5s', { retryDelaySeconds: 5 });
        return { ok: true, status: 200, body: makeReadableStream([sse]) };
      },
    });
    try {
      const res = await post(server.address().port, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('fallback-ok'));
      assert.ok(store.get('key-1', 'a').cooldown_until > Date.now(), 'model a cooling down');
      assert.equal(store.get('key-1', 'b').daily_count, 1);
      assert.equal(store.get('key-1', 'a').daily_count, 0);
    } finally { server.close(); }
  });

  it('returns 429 JSON when all pairs are exhausted (before any byte)', async () => {
    const store = new StateStore(null);
    const st = store.get('key-1', 'a');
    st.request_timestamps = [Date.now() - 1000]; // cày hết RPM của model a
    const models = [{ name: 'a', priority: 1, limits: { rpm: 1, rpd: 100, tpm: 1000000 } }];
    const server = await makeApp(store, { callOpenAIStream: async () => {
      throw new Error('must not be called');
    } }, models);
    try {
      const res = await post(server.address().port, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(res.status, 429);
      assert.ok(res.body.includes('error'), 'error body in OpenAI format');
    } finally { server.close(); }
  });

  it('upstream 400 before open -> 400 JSON, no cooldown', async () => {
    const store = new StateStore(null);
    const server = await makeApp(store, {
      callOpenAIStream: async () => { throw new GeminiError('Gemini error 400: bad request', { status: 400 }); },
    });
    try {
      const res = await post(server.address().port, { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(res.status, 400);
      assert.ok(!store.get('key-1', 'a').cooldown_until, '400 must not set cooldown');
      assert.equal(store.get('key-1', 'a').inflight_count, 0, 'released on failure');
    } finally { server.close(); }
  });
});
