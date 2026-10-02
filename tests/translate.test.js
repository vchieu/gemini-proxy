const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { openAiToGemini, geminiToOpenAi } = require('../api/translate');
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
