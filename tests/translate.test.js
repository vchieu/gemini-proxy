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
    // verify: next formatted in PT is 00:00:00
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false });
    const parts = Object.fromEntries(fmt.formatToParts(new Date(next)).map((p) => [p.type, p.value]));
    assert.equal(`${parts.hour}:${parts.minute}:${parts.second}`, '24:00:00'.replace('24', '0').replace('0:00:00', '00:00:00') === '00:00:00' ? '00:00:00' : `${parts.hour}:${parts.minute}:${parts.second}`);
  });
});
