const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { openAiToGemini, geminiToOpenAi, geminiChunkToOpenAiChunk, attachThoughtSignature } = require('../api/translate');
const { estimateTokens } = require('../utils/tokenEstimate');
const { nextMidnightPacific } = require('../utils/time');

describe('translate', () => {
  it('maps system/user/assistant roles', () => {
    const g = openAiToGemini({ messages: [
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ] });
    assert.equal(g.systemInstruction.parts[0].text, 'you are helpful');
    assert.equal(g.contents[0].role, 'user');
    assert.equal(g.contents[1].role, 'model');
  });
  it('maps gemini response to OpenAI', () => {
    const oai = geminiToOpenAi({
      candidates: [{ content: { parts: [{ text: 'abc' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
    }, 'gemini-2.5-flash');
    assert.equal(oai.choices[0].message.content, 'abc');
    assert.equal(oai.usage.total_tokens, 13);
    assert.equal(oai.model, 'gemini-2.5-flash');
  });

  it('translates tools to functionDeclarations', () => {
    const g = openAiToGemini({
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      }],
    });
    assert.ok(g.tools);
    assert.equal(g.tools[0].functionDeclarations[0].name, 'get_weather');
    assert.equal(g.tools[0].functionDeclarations[0].description, 'Get weather');
  });

  it('strips JSON Schema keys Gemini does not support (nguyên nhân 400 Unknown name)', () => {
    // Schema kiểu OpenCode/zod gửi lên: additionalProperties, exclusiveMinimum, $schema...
    const g = openAiToGemini({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        type: 'function',
        function: {
          name: 'f',
          description: 'd',
          parameters: {
            type: 'object',
            additionalProperties: false,
            $schema: 'http://json-schema.org/draft-07/schema',
            $defs: { a: { type: 'string' } },
            properties: {
              n: { type: 'number', exclusiveMinimum: 0, minimum: 1 },
              arr: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } } } },
              u: { oneOf: [{ type: 'string' }, { type: 'number' }] },
              meta: { type: 'object', example: { foo: 'bar' }, default: { keep: true } },
            },
            required: ['n'],
          },
        },
      }],
    });
    const p = g.tools[0].functionDeclarations[0].parameters;
    const json = JSON.stringify(p);
    // các field Gemini trả 400 "Unknown name" phải bị loại, kể cả nested
    assert.ok(!json.includes('additionalProperties'));
    assert.ok(!json.includes('exclusiveMinimum'));
    assert.ok(!json.includes('$schema'));
    assert.ok(!json.includes('$defs'));
    // giữ lại field hợp lệ
    assert.equal(p.properties.n.minimum, 1);
    assert.deepEqual(p.required, ['n']);
    assert.equal(p.properties.arr.items.properties.x.type, 'string');
    // oneOf -> anyOf (Gemini chỉ có anyOf), giá trị example/default giữ nguyên
    assert.deepEqual(p.properties.u.anyOf, [{ type: 'string' }, { type: 'number' }]);
    assert.deepEqual(p.properties.meta.example, { foo: 'bar' });
    assert.deepEqual(p.properties.meta.default, { keep: true });
  });

  it('translates tool_choice to toolConfig', () => {
    const g = openAiToGemini({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f', description: '', parameters: {} } }],
      tool_choice: 'none',
    });
    assert.equal(g.toolConfig.functionCallingConfig.mode, 'NONE');
  });

  it('translates assistant tool_calls to functionCall', () => {
    const g = openAiToGemini({
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"HN"}' },
          }],
        },
      ],
    });
    assert.equal(g.contents[1].role, 'model');
    const fc = g.contents[1].parts.find((p) => p.functionCall);
    assert.ok(fc, 'should have functionCall part');
    assert.equal(fc.functionCall.name, 'get_weather');
    assert.deepEqual(fc.functionCall.args, { city: 'HN' });
  });

  it('translates tool result to functionResponse', () => {
    const g = openAiToGemini({
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"temp":25}' },
      ],
    });
    assert.equal(g.contents[2].role, 'user');
    assert.equal(g.contents[2].parts[0].functionResponse.name, 'get_weather');
    assert.deepEqual(g.contents[2].parts[0].functionResponse.response, { temp: 25 });
  });

  it('maps gemini functionCall to OpenAI tool_calls', () => {
    const oai = geminiToOpenAi({
      candidates: [{
        content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'HN' } } }] },
        finishReason: 'STOP',
      }],
    }, 'gemini-2.5-flash');
    assert.ok(oai.choices[0].message.tool_calls);
    assert.equal(oai.choices[0].message.tool_calls[0].function.name, 'get_weather');
    assert.equal(oai.choices[0].message.tool_calls[0].function.arguments, '{"city":"HN"}');
    assert.equal(oai.choices[0].finish_reason, 'tool_calls');
  });

  it('resolves PARALLEL tool calls to correct function names (id roundtrip)', () => {
    // Gemini trả 2 functionCall song song trong 1 response
    const oai = geminiToOpenAi({
      candidates: [{
        content: { parts: [
          { functionCall: { name: 'get_weather', args: { city: 'HN' } } },
          { functionCall: { name: 'get_time', args: {} } },
        ] },
        finishReason: 'STOP',
      }],
    }, 'gemini-2.5-flash');
    const tcs = oai.choices[0].message.tool_calls;
    assert.equal(tcs.length, 2);

    // Client echo lại id + kết quả theo thứ tự tool_calls
    const g = openAiToGemini({
      messages: [
        { role: 'user', content: 'weather & time?' },
        { role: 'assistant', content: null, tool_calls: tcs },
        { role: 'tool', tool_call_id: tcs[0].id, content: '{"temp":25}' },
        { role: 'tool', tool_call_id: tcs[1].id, content: '07:00' },
      ],
    });
    const responses = g.contents
      .filter((c) => c.parts.some((p) => p.functionResponse))
      .map((c) => c.parts.find((p) => p.functionResponse).functionResponse.name);
    assert.deepEqual(responses, ['get_weather', 'get_time']);
  });

  it('falls back to FIFO when tool_call_id has no embedded name (old format)', () => {
    const g = openAiToGemini({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
          { id: 'call_2', type: 'function', function: { name: 'get_time', arguments: '{}' } },
        ] },
        { role: 'tool', tool_call_id: 'call_1', content: '25' },
        { role: 'tool', tool_call_id: 'call_2', content: '07:00' },
      ],
    });
    const responses = g.contents
      .filter((c) => c.parts.some((p) => p.functionResponse))
      .map((c) => c.parts.find((p) => p.functionResponse).functionResponse.name);
    assert.deepEqual(responses, ['get_weather', 'get_time']);
  });

  it('roundtrips thoughtSignature qua tool_call id (Gemini 3 bắt buộc khi replay functionCall)', () => {
    const SIG = 'EqoDCqcDAWkUfRN6Iv88+z/xA==';
    // Response từ Gemini: thoughtSignature là field của Part, cùng part với functionCall
    const oai = geminiToOpenAi({
      candidates: [{
        content: { parts: [{ functionCall: { name: 'shell', args: { cmd: 'ls' } }, thoughtSignature: SIG }] },
        finishReason: 'STOP',
      }],
    }, 'gemini-3.8-flash');
    const tc = oai.choices[0].message.tool_calls[0];
    assert.ok(tc.id.startsWith('callsig_'), 'id phải mang prefix callsig_ khi có signature');

    // Client echo nguyên id trong history -> proxy gắn lại signature khi build Gemini request
    const g = openAiToGemini({
      messages: [
        { role: 'user', content: 'run ls' },
        { role: 'assistant', content: null, tool_calls: [tc] },
        { role: 'tool', tool_call_id: tc.id, content: 'file.txt' },
      ],
    });
    const fcPart = g.contents.flatMap((c) => c.parts).find((p) => p.functionCall);
    assert.ok(fcPart, 'phải có functionCall part');
    assert.equal(fcPart.thoughtSignature, SIG, 'phải gắn lại thoughtSignature nguyên vẹn');
    assert.equal(fcPart.functionCall.name, 'shell');
    // functionResponse vẫn resolve đúng tên function từ id mới
    const fr = g.contents.flatMap((c) => c.parts).find((p) => p.functionResponse);
    assert.equal(fr.functionResponse.name, 'shell');
  });

  it('streaming chunk cũng nhúng thoughtSignature vào tool_call id', () => {
    const SIG = 'stream-sig-abc+123/==';
    const chunk = geminiChunkToOpenAiChunk({
      candidates: [{
        content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'HN' } }, thoughtSignature: SIG }] },
        finishReason: 'STOP',
      }],
    }, 'gemini-3.8-flash', 'chatcmpl-x', 1, 0);
    const tc = chunk.choices[0].delta.tool_calls[0];
    assert.ok(tc.id.startsWith('callsig_'));
    assert.ok(tc.id.endsWith(`_${SIG}`), 'signature phải nằm nguyên ở đuôi id');
    // id không nhúng signature (2.5 không trả) -> format cũ, không regression
    const noSig = geminiChunkToOpenAiChunk({
      candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: {} } }] }, finishReason: 'STOP' }],
    }, 'gemini-2.5-flash', 'chatcmpl-x', 1, 0);
    assert.ok(noSig.choices[0].delta.tool_calls[0].id.startsWith('call_'));
  });

  it('gom thoughtSignature từ part RIÊNG (không cùng part với functionCall)', () => {
    const SIG = 'orphan-sig+xyz/==';
    // Response thật: Gemini đôi khi để thoughtSignature ở part riêng, KHÔNG kèm functionCall
    const oai = geminiToOpenAi({
      candidates: [{
        content: { parts: [
          { functionCall: { name: 'read', args: { path: 'x.js' } } },
          { thoughtSignature: SIG },
        ] },
        finishReason: 'STOP',
      }],
    }, 'gemini-3.8-flash');
    const tc = oai.choices[0].message.tool_calls[0];
    assert.ok(tc.id.startsWith('callsig_'), 'phải gán sig từ orphan part');
    assert.ok(tc.id.endsWith(`_${SIG}`));

    // gán sig muộn cho id đã phát ra ở format cũ (dùng cho streaming cross-chunk)
    const late = attachThoughtSignature('call_read_71snibw6', SIG);
    assert.ok(late.startsWith('callsig_read_71snibw6_'));
    assert.ok(late.endsWith(`_${SIG}`));
    // id không parse được -> giữ nguyên, không phá id
    assert.equal(attachThoughtSignature('call_1', SIG), 'call_1');
    // đã có sig -> không gán đè
    const withSig = 'callsig_read_abc12345_old';
    assert.equal(attachThoughtSignature(withSig, SIG), withSig);
  });

  it('adds required index to streaming tool_calls deltas (cumulative across chunks)', () => {
    const mkChunk = (name, offset) => geminiChunkToOpenAiChunk({
      candidates: [{ content: { parts: [{ functionCall: { name, args: {} } }] }, finishReason: 'STOP' }],
    }, 'gemini-2.5-flash', 'chatcmpl-x', 1, offset);

    const c1 = mkChunk('get_weather', 0);
    assert.equal(c1.choices[0].delta.tool_calls[0].index, 0);
    assert.equal(c1.choices[0].finish_reason, 'tool_calls');

    const c2 = mkChunk('get_time', 1);
    assert.equal(c2.choices[0].delta.tool_calls[0].index, 1);
    // backward-compat: không truyền offset vẫn mặc định 0
    const c3 = mkChunk('get_weather');
    assert.equal(c3.choices[0].delta.tool_calls[0].index, 0);
  });
});

describe('tokenEstimate', () => {
  it('estimates chars/4', () => {
    assert.equal(estimateTokens('abcd'), 1);
    assert.ok(estimateTokens([{ role: 'user', content: 'hello world' }]) > 0);
  });
});

describe('nextMidnightPacific', () => {
  it('returns a future PT midnight', () => {
    const now = Date.UTC(2026, 0, 15, 12, 0, 0);
    const next = nextMidnightPacific(now);
    assert.ok(next > now);
    // verify: next formatted in PT is 00:00:00 (ICU có thể trả hour "0" hoặc "24")
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false });
    const parts = Object.fromEntries(fmt.formatToParts(new Date(next)).map((p) => [p.type, p.value]));
    const hour = parts.hour === '24' ? '00' : parts.hour.padStart(2, '0');
    assert.equal(`${hour}:${parts.minute}:${parts.second}`, '00:00:00');
  });
});
