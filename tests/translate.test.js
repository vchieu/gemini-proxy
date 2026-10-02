const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { openAiToGemini, geminiToOpenAi, geminiChunkToOpenAiChunk } = require('../api/translate');
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
