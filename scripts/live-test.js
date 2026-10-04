#!/usr/bin/env node
/**
 * Phase 6 — Live test cho upstream_mode=openai_compat (xem
 * PLAN-openai-compat-migration.md §6.2).
 *
 * Chạy TUẦN TỰ, mỗi scenario cách ≥ 2.1s (ngân sách RPM 5/phút),
 * in bảng PASS/FAIL, thoát code ≠ 0 nếu có FAIL.
 *
 * Dùng:  node scripts/live-test.js
 *        LIVE_BASE=http://localhost:8787 node scripts/live-test.js
 *
 * ⛔ Không hề chứa/hiện API key (proxy giữ key phía sau).
 * Ng ngân sách upstream ghi ở cột "req" — tổng phải ≤ 28 (plan §2.3).
 */
'use strict';

const BASE = process.env.LIVE_BASE || 'http://localhost:8787';
const SHORT_PROMPT = 'Reply with the single word: ok';
const GAP_MS = Number(process.env.LIVE_GAP_MS || 2100);
// Chạy lẻ 1 vài scenario để tiết kiệm quota: LIVE_ONLY=L3,L4,L5
const ONLY = (process.env.LIVE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let upstreamUsed = 0;
const results = [];

// ---------------------------------------------------------------- helpers
async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = undefined; }
  return { status: res.status, text, json };
}

async function postChat(body, { signal } = {}) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = undefined; }
  return { status: res.status, text, json };
}

/** Gọi và đọc toàn bộ SSE thành text (đợi response đóng). */
async function postChatSse(body) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

/** Trích payload JSON từ các dòng `data:` (bỏ [DONE]). */
function sseEvents(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { out.push(JSON.parse(payload)); } catch (_) { /* bỏ qua */ }
  }
  return out;
}

const countOf = (hay, needle) => hay.split(needle).length - 1;

async function record(id, desc, cost, fn) {
  if (ONLY.length && !ONLY.includes(id)) return;
  let ok = false;
  let detail = '';
  let note = '';
  let spent = 0;
  try {
    const r = await fn();
    ok = !!r.ok;
    detail = r.detail || '';
    note = r.note || '';
    // Scenario có thể bỏ qua (vd. phụ thuộc L3) -> không tốn request thật
    spent = typeof r.cost === 'number' ? r.cost : cost;
  } catch (e) {
    detail = `threw: ${e.message}`;
  }
  upstreamUsed += spent;
  results.push({ id, desc, cost: spent, ok, detail, note });
  await sleep(GAP_MS);
}

// ---------------------------------------------------------------- scenarios
const chatTool = () => ({
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    },
  },
});

async function main() {
  console.log(`Live test against ${BASE} (gap ${GAP_MS}ms)\n`);

  // ---- L0: chỉ local, không tốn upstream ----
  await record('L0', 'GET /health, /v1/models, /admin/status', 0, async () => {
    const h = await get('/health');
    const m = await get('/v1/models');
    const a = await get('/admin/status');
    const mode = a.json && a.json.upstream_mode;
    return {
      ok: h.status === 200 && m.status === 200 && a.status === 200 && mode === 'openai_compat',
      detail: `health=${h.status} models=${m.status} admin=${a.status} upstream_mode=${mode}`,
    };
  });

  // ---- L1: non-stream ----
  let l3 = null; // kết quả L3 để replay ở L4/L5
  await record('L1', 'POST chat non-stream', 1, async () => {
    const r = await postChat({ model: 'auto', messages: [{ role: 'user', content: SHORT_PROMPT }] });
    const msg = r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message;
    const usage = r.json && r.json.usage;
    const model = r.json && r.json.model;
    return {
      ok: r.status === 200
        && typeof (msg && msg.content) === 'string' && msg.content.length > 0
        && usage && usage.total_tokens > 0
        && /gemini/i.test(String(model)),
      detail: `status=${r.status} model=${model} tokens=${usage && usage.total_tokens} content=${JSON.stringify(String(msg && msg.content).slice(0, 40))}`,
    };
  });

  // ---- L2: stream, agent KHÔNG gửi stream_options ----
  await record('L2', 'POST chat stream (không stream_options)', 1, async () => {
    const r = await postChatSse({ model: 'auto', stream: true, messages: [{ role: 'user', content: SHORT_PROMPT }] });
    const events = sseEvents(r.text);
    const hasContent = events.some((e) => e.choices && e.choices[0] && e.choices[0].delta
      && typeof e.choices[0].delta.content === 'string' && e.choices[0].delta.content.length > 0);
    const hasUsageOnly = events.some((e) => Array.isArray(e.choices) && e.choices.length === 0);
    return {
      ok: r.status === 200 && hasContent
        && countOf(r.text, '[DONE]') === 1
        && !hasUsageOnly,
      detail: `status=${r.status} events=${events.length} [DONE]=${countOf(r.text, '[DONE]')} usageOnlyChunk=${hasUsageOnly}`,
    };
  });

  // ---- L2b: stream CÓ stream_options.include_usage ----
  await record('L2b', 'POST chat stream (include_usage=true)', 1, async () => {
    const r = await postChatSse({
      model: 'auto', stream: true, messages: [{ role: 'user', content: SHORT_PROMPT }],
      stream_options: { include_usage: true },
    });
    const events = sseEvents(r.text);
    const usageOnly = events.filter((e) => Array.isArray(e.choices) && e.choices.length === 0 && e.usage);
    const usageOnNormal = events.filter((e) => e.usage && Array.isArray(e.choices) && e.choices.length > 0);
    const usageAnywhere = events.some((e) => e.usage && e.usage.total_tokens);
    return {
      // upstream có trả usage (ở chunk nào cũng được) + đúng 1 [DONE]
      ok: r.status === 200 && usageAnywhere && countOf(r.text, '[DONE]') === 1,
      detail: `status=${r.status} events=${events.length} usageOnlyChunk=${usageOnly.length} usageOnNormalChunk=${usageOnNormal.length} [DONE]=${countOf(r.text, '[DONE]')}`,
      note: usageOnly.length
        ? 'Q5: upstream tách chunk usage-only (choices:[])'
        : 'Q5: upstream gắn usage vào chunk CÓ choices (không tách usage-only) — proxy vẫn ghi quota được',
    };
  });

  // ---- L3: non-stream + tool (đồng thời ghi nhận thoughtSignature -> xác định Case) ----
  await record('L3', 'Non-stream + tool_choice=required', 1, async () => {
    const r = await postChat({
      model: 'auto',
      messages: [{ role: 'user', content: 'What is the weather in Paris right now? Use the get_weather tool.' }],
      tools: [chatTool()],
      tool_choice: 'required',
    });
    const choice = r.json && r.json.choices && r.json.choices[0];
    const msg = choice && choice.message;
    const tc = msg && Array.isArray(msg.tool_calls) ? msg.tool_calls[0] : null;
    let argsOk = false;
    try { JSON.parse(tc && tc.function && tc.function.arguments); argsOk = true; } catch (_) { argsOk = false; }

    // Q1: thoughtSignature nằm ở đâu? Quét toàn bộ message (không chỉ tool_calls).
    const sigPaths = [];
    const unknownKeys = [];
    const walk = (obj, prefix) => {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        const p = prefix ? `${prefix}.${k}` : k;
        if (/signature/i.test(k) && typeof v === 'string') sigPaths.push(`${p}=<${v.length} chars>`);
        else if (v && typeof v === 'object') walk(v, p);
      }
    };
    if (msg) {
      walk(msg, 'message');
      // field lạ client có thể làm rơi (Q2) — so với OpenAI spec chuẩn
      for (const k of Object.keys(msg)) {
        if (!['role', 'content', 'refusal', 'tool_calls', 'function_call'].includes(k)) unknownKeys.push(k);
      }
      if (tc) {
        for (const k of Object.keys(tc)) {
          if (!['id', 'type', 'function', 'index'].includes(k)) unknownKeys.push(`tool_calls[0].${k}`);
        }
      }
    }
    const note = [
      `Q1 signature: ${sigPaths.length ? sigPaths.join(', ') : 'KHÔNG CÓ field signature nào'}`,
      `Q2 field lạ (client có thể làm rơi): ${unknownKeys.length ? unknownKeys.join(', ') : 'không có'}`,
    ].join(' | ');
    if (tc) l3 = { raw: tc, argsRaw: tc.function.arguments, name: tc.function.name };

    return {
      ok: r.status === 200
        && choice && choice.finish_reason === 'tool_calls'
        && tc && tc.function.name === 'get_weather' && argsOk,
      detail: `status=${r.status} finish=${choice && choice.finish_reason} name=${tc && tc.function && tc.function.name} argsOk=${argsOk}`,
      note,
    };
  });

  // ---- L4: replay multi-turn ----
  await record('L4', 'Replay [user, assistant(tool_calls), tool(result)]', 1, async () => {
    if (!l3) return { ok: false, detail: 'L3 chưa chạy thành công, bỏ qua', cost: 0 };
    const r = await postChat({
      model: 'auto',
      messages: [
        { role: 'user', content: 'What is the weather in Paris right now? Use the get_weather tool.' },
        { role: 'assistant', content: null, tool_calls: [l3.raw] },
        { role: 'tool', tool_call_id: l3.raw.id, content: '{"city":"Paris","temp_c":21,"conditions":"sunny"}' },
      ],
      tools: [chatTool()],
    });
    const msg = r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message;
    return {
      ok: r.status === 200 && typeof (msg && msg.content) === 'string' && msg.content.length > 0,
      detail: `status=${r.status} content=${JSON.stringify(String(msg && msg.content).slice(0, 50))}`,
    };
  });

  // ---- L5: replay nhưng client "làm rơi" field lạ (chỉ giữ id/type/function) ----
  await record('L5', 'Replay với tool_calls đã bị client strip field lạ', 1, async () => {
    if (!l3) return { ok: false, detail: 'L3 chưa chạy thành công, bỏ qua', cost: 0 };
    const stripped = {
      id: l3.raw.id,
      type: l3.raw.type || 'function',
      function: { name: l3.raw.function.name, arguments: l3.argsRaw },
    };
    const r = await postChat({
      model: 'auto',
      messages: [
        { role: 'user', content: 'What is the weather in Paris right now? Use the get_weather tool.' },
        { role: 'assistant', content: null, tool_calls: [stripped] },
        { role: 'tool', tool_call_id: l3.raw.id, content: '{"city":"Paris","temp_c":21}' },
      ],
      tools: [chatTool()],
    });
    const msg = r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message;
    const strippedFields = Object.keys(l3.raw).filter((k) => !['id', 'type', 'function'].includes(k));
    return {
      ok: r.status === 200,
      detail: `status=${r.status} strippedFields=[${strippedFields.join(',')}] content=${JSON.stringify(String(msg && (msg.content || '')).slice(0, 40))}`,
      note: r.status === 200
        ? 'Case A: field lạ KHÔNG bắt buộc (replay không cần signature)'
        : `Case B/C: replay 400 -> cần shim qua tool_call_id (${r.status}: ${String(r.json && r.json.error && r.json.error.message).slice(0, 90)})`,
    };
  });

  // ---- L6: stream + tool, gom delta rồi replay ----
  await record('L6', 'Stream + tool: gom delta rồi replay (2 req)', 2, async () => {
    if (!l3) return { ok: false, detail: 'L3 chưa chạy thành công, bỏ qua', cost: 0 };
    const r = await postChatSse({
      model: 'auto',
      stream: true,
      messages: [{ role: 'user', content: 'What is the weather in Paris right now? Use the get_weather tool.' }],
      tools: [chatTool()],
      tool_choice: 'required',
    });
    const events = sseEvents(r.text);
    let id = null, name = '', args = '', indexOk = true, sawIndex = false;
    for (const e of events) {
      const d = e.choices && e.choices[0] && e.choices[0].delta;
      const tc = d && d.tool_calls && d.tool_calls[0];
      if (!tc) continue;
      if (typeof tc.index === 'number') sawIndex = true;
      if (tc.id) id = tc.id;
      if (tc.function && tc.function.name) name = tc.function.name;
      if (tc.function && tc.function.arguments) args += tc.function.arguments;
    }
    if (sawIndex) indexOk = true;
    let argsOk = false;
    try { JSON.parse(args); argsOk = true; } catch (_) { argsOk = false; }
    if (!id || !name || !argsOk) {
      return { ok: false, detail: `gom delta lỗi: id=${!!id} name=${name || '-'} argsOk=${argsOk}` };
    }
    const replay = await postChat({
      model: 'auto',
      messages: [
        { role: 'user', content: 'What is the weather in Paris right now? Use the get_weather tool.' },
        { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: args } }] },
        { role: 'tool', tool_call_id: id, content: '{"city":"Paris","temp_c":21}' },
      ],
      tools: [chatTool()],
    });
    const msg = replay.json && replay.json.choices && replay.json.choices[0] && replay.json.choices[0].message;
    return {
      ok: replay.status === 200 && typeof (msg && msg.content) === 'string' && msg.content.length > 0,
      detail: `streamStatus=${r.status} sawIndex=${sawIndex} replay=${replay.status} content=${JSON.stringify(String(msg && msg.content).slice(0, 40))}`,
    };
  });

  // ---- L7: schema "bẩn" (Q4) ----
  await record('L7', 'Non-stream với JSON Schema "bẩn"', 1, async () => {
    const r = await postChat({
      model: 'auto',
      messages: [{ role: 'user', content: 'Use search_book to find the book Dune by Frank Herbert.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'search_book',
          description: 'Search a book',
          parameters: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string', examples: ['Dune'], default: '' },
              page: { type: 'integer', minimum: 1, exclusiveMinimum: 0 },
              filter: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            },
            required: ['query'],
          },
        },
      }],
      tool_choice: 'auto',
    });
    return {
      ok: r.status === 200,
      detail: `status=${r.status}${r.status !== 200 ? ' err=' + String(r.text).slice(0, 160) : ''}`,
      note: r.status === 200 ? 'Q4: endpoint chấp nhận schema bẩn (không cần sanitize)'
        : 'Q4: endpoint 400 với schema bẩn -> cần sanitize trước khi forward',
    };
  });

  // ---- L8a: thiếu messages (local, không tốn upstream) ----
  await record('L8a', 'Thiếu messages -> 400 invalid_request_error', 0, async () => {
    const r = await postChat({ model: 'auto' });
    return {
      ok: r.status === 400 && r.json && r.json.error && r.json.error.type === 'invalid_request_error',
      detail: `status=${r.status} type=${r.json && r.json.error && r.json.error.type}`,
    };
  });

  // ---- L8b: Google trả 400 -> propagates, không cooldown ----
  await record('L8b', 'Lỗi 400 từ Google propagates + không cooldown', 1, async () => {
    const before = await get('/admin/status');
    const coolingBefore = new Set((before.json.pairs || [])
      .filter((p) => p.cooldown_remaining_ms > 0).map((p) => `${p.key}/${p.model}`));
    const r = await postChat({ model: 'auto', messages: [{ role: 'not_a_real_role', content: 'hi' }] });
    await sleep(400);
    const after = await get('/admin/status');
    const newCooling = (after.json.pairs || [])
      .filter((p) => p.cooldown_remaining_ms > 0 && !coolingBefore.has(`${p.key}/${p.model}`));
    return {
      ok: r.status === 400 && newCooling.length === 0,
      detail: `status=${r.status} newCooldown=${newCooling.length ? newCooling.map((p) => p.key + '/' + p.model).join(',') : 'none'} body=${String(r.text).slice(0, 120)}`,
      note: r.status === 400 ? '' : 'Google không 400 với role lạ -> cần spike S9 để tìm trigger 400 thật',
    };
  });

  // ---- L9: client ngắt giữa stream ----
  await record('L9', 'Client disconnect giữa stream (2 req)', 2, async () => {
    const ac = new AbortController();
    let chunks = 0;
    try {
      const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'Write a very long paragraph about rivers.' }] }),
        signal: ac.signal,
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      while (chunks < 2) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks += dec.decode(value).length > 0 ? 1 : 0;
      }
      ac.abort();
    } catch (_) { /* abort là chủ đích */ }
    await sleep(1200);

    const st = await get('/admin/status');
    const inflight = (st.json.pairs || []).reduce(
      (s, p) => s + (p.inflight_count || 0) + (p.inflight_tokens || 0), 0);

    // Request thường phải chạy được (không kẹt reservation)
    const follow = await postChat({ model: 'auto', messages: [{ role: 'user', content: SHORT_PROMPT }] });
    return {
      ok: chunks >= 1 && inflight === 0 && follow.status === 200,
      detail: `chunks=${chunks} inflightAfter=${inflight} followUp=${follow.status}`,
    };
  });

  // ---- L10: vượt RPM -> fallback (CHỈ nếu còn ngân sách) ----
  await record('L10', '6 request liên tiếp -> fallback khi vượt RPM', 6, async () => {
    const codes = [];
    const models = new Set();
    for (let i = 0; i < 6; i += 1) {
      const r = await postChat({ model: 'auto', messages: [{ role: 'user', content: SHORT_PROMPT }] });
      codes.push(r.status);
      if (r.json && r.json.model) models.add(r.json.model);
      await sleep(2100);
    }
    const all200 = codes.every((c) => c === 200);
    return {
      ok: all200 && models.size >= 2,
      detail: `codes=[${codes.join(',')}] models=[${[...models].join(', ')}]`,
      note: models.size >= 2 ? 'đã xoay qua ≥2 model khi hết RPM' : 'chỉ 1 model (RPM chưa hết / bank chưa chạm)',
    };
  });

  // ---- L11: tool-loop 3 vòng ----
  await record('L11', 'Tool-loop 3 vòng liên tiếp', 3, async () => {
    const msgs = [{ role: 'user', content: 'Get the weather for Paris, then London, then Tokyo. Use get_weather each time.' }];
    let okAll = true;
    const statuses = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await postChat({ model: 'auto', messages: msgs, tools: [chatTool()], tool_choice: 'auto' });
      statuses.push(r.status);
      if (r.status !== 200) { okAll = false; break; }
      const choice = r.json.choices[0];
      if (choice.message.tool_calls && choice.message.tool_calls.length) {
        msgs.push({ role: 'assistant', content: null, tool_calls: choice.message.tool_calls });
        msgs.push({ role: 'tool', tool_call_id: choice.message.tool_calls[0].id, content: '{"temp_c":20}' });
      }
      await sleep(2100);
    }
    return { ok: okAll, detail: `statuses=[${statuses.join(',')}]` };
  });

  // ---------------------------------------------------------------- report
  console.log('ID    req  RESULT  scenario');
  console.log('----  ---  ------  ------------------------------------------------');
  for (const r of results) {
    console.log(`${r.id.padEnd(5)} ${String(r.cost).padStart(3)}  ${(r.ok ? 'PASS' : 'FAIL').padEnd(6)}  ${r.desc}`);
    if (r.detail) console.log(`${' '.repeat(24)}${r.detail}`);
    if (r.note) console.log(`${' '.repeat(24)}NOTE: ${r.note}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS — upstream requests used: ${upstreamUsed}/28`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e && e.message);
  process.exit(2);
});
