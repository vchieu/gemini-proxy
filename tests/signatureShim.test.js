const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { responseToClient, requestToUpstream, chunkToClient, readThoughtSignature } = require('../api/signatureShim');

const SIG = 'SIG_VALUE_with_underscores_and+/==';
const mkTc = (name, extra) => ({
  id: 'callabc_123',
  type: 'function',
  function: { name, arguments: '{"city":"Paris"}' },
  ...(extra || {}),
});

const withSig = (name) => ({
  ...mkTc(name),
  extra_content: { google: { thought_signature: SIG } },
});

describe('signatureShim (Case B: extra_content <-> callsig_ id)', () => {
  it('readThoughtSignature finds the observed Google shape', () => {
    assert.equal(readThoughtSignature(withSig('get_weather')), SIG);
    assert.equal(readThoughtSignature(mkTc('get_weather')), undefined);
    assert.equal(readThoughtSignature({ extra_content: {} }), undefined);
    assert.equal(readThoughtSignature(null), undefined);
  });

  it('responseToClient embeds the signature into the id and drops extra_content', () => {
    const res = {
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [withSig('get_weather')] } }],
    };
    const out = responseToClient(res);
    const tc = out.choices[0].message.tool_calls[0];
    assert.ok(tc.id.startsWith('callsig_'), `id must be callsig_, got ${tc.id}`);
    assert.ok(tc.id.endsWith(`_${SIG}`), 'id must carry the signature at the tail');
    assert.equal('extra_content' in tc, false, 'extra_content must be removed (client would drop it anyway)');
    assert.equal(tc.function.name, 'get_weather', 'function payload untouched');
  });

  it('responseToClient leaves tool_calls without signature alone', () => {
    const res = { choices: [{ message: { tool_calls: [mkTc('f')] } }] };
    const out = responseToClient(res);
    assert.equal(out.choices[0].message.tool_calls[0].id, 'callabc_123');
  });

  it('responseToClient tolerates non-tool responses', () => {
    const res = { choices: [{ message: { role: 'assistant', content: 'hi' } }] };
    assert.equal(responseToClient(res), res);
    assert.equal(responseToClient(undefined), undefined);
  });

  it('roundtrip: responseToClient -> client drops fields -> requestToUpstream restores the SAME sig', () => {
    const upstream = { choices: [{ message: { tool_calls: [withSig('get_weather')] } }] };
    responseToClient(upstream);
    const sentByClient = upstream.choices[0].message.tool_calls[0];
    // client mô phỏng OpenAI chuẩn: chỉ giữ id/type/function
    const echoed = {
      model: 'auto',
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: null, tool_calls: [
          { id: sentByClient.id, type: 'function', function: { ...sentByClient.function } },
        ] },
        { role: 'tool', tool_call_id: sentByClient.id, content: '{}' },
      ],
    };
    const up = requestToUpstream(echoed);
    const tc = up.messages[1].tool_calls[0];
    assert.equal(readThoughtSignature(tc), SIG, 'signature must come back from the id');
    assert.deepEqual(tc.extra_content, { google: { thought_signature: SIG } });
    assert.equal(up.messages[1].tool_calls[0].id, sentByClient.id, 'id preserved for Google');
  });

  it('requestToUpstream is idempotent when the client DID echo extra_content', () => {
    const echoed = { messages: [{ role: 'assistant', tool_calls: [withSig('f')] }] };
    const before = JSON.stringify(echoed);
    requestToUpstream(echoed);
    assert.equal(JSON.stringify(echoed), before, 'must not double-wrap extra_content');
  });

  it('requestToUpstream ignores ids that carry no signature', () => {
    const echoed = { messages: [{ role: 'assistant', tool_calls: [mkTc('f')] }] };
    requestToUpstream(echoed);
    assert.equal('extra_content' in echoed.messages[0].tool_calls[0], false);
  });

  it('requestToUpstream leaves non-assistant / non-tool messages untouched', () => {
    const echoed = { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }] };
    assert.doesNotThrow(() => requestToUpstream(echoed));
    assert.equal(echoed.messages[0].content, 'hi');
    const noMsgs = {};
    assert.equal(requestToUpstream(noMsgs), noMsgs);
  });

  it('chunkToClient rewrites id when signature and name arrive in the same delta', () => {
    const chunk = { choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'callabc_1', type: 'function', function: { name: 'get_weather', arguments: '' },
        extra_content: { google: { thought_signature: SIG } } },
    ] } }] };
    const out = chunkToClient(chunk, {});
    assert.equal(out.changed, true);
    assert.equal(out.unshimmed, false);
    const tc = out.chunk.choices[0].delta.tool_calls[0];
    assert.ok(tc.id.startsWith('callsig_') && tc.id.endsWith(`_${SIG}`));
    assert.equal('extra_content' in tc, false);
  });

  it('chunkToClient uses the remembered name when the signature comes in a LATER delta', () => {
    const state = {};
    // delta 1: chỉ có id + name (Google phát id ở delta đầu)
    chunkToClient({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'callabc_1', function: { name: 'get_weather', arguments: '' } },
    ] } }] }, state);
    // delta 2: chỉ có sig, không lặp lại name
    const out = chunkToClient({ choices: [{ delta: { tool_calls: [
      { index: 0, extra_content: { google: { thought_signature: SIG } } },
    ] } }] }, state);
    assert.equal(out.changed, true, 'name remembered in state must let us rebuild the id');
    const tc = out.chunk.choices[0].delta.tool_calls[0];
    assert.ok(tc.id.startsWith('callsig_') && tc.id.endsWith(`_${SIG}`));
    assert.equal('extra_content' in tc, false);
  });

  it('chunkToClient flags unshimmmable signature (no name anywhere)', () => {
    const out = chunkToClient({ choices: [{ delta: { tool_calls: [
      { index: 0, extra_content: { google: { thought_signature: SIG } } },
    ] } }] }, {});
    assert.equal(out.changed, false);
    assert.equal(out.unshimmed, true, 'caller must WARN — client will drop the signature');
  });

  it('chunkToClient is a no-op for normal text / usage-only chunks (payload stays verbatim)', () => {
    const text = { choices: [{ delta: { content: 'hello' } }] };
    const out = chunkToClient(text, {});
    assert.equal(out.changed, false);
    assert.equal(out.chunk, text, 'same object, no rewrite needed');
    const usageOnly = { choices: [], usage: { total_tokens: 9 } };
    assert.equal(chunkToClient(usageOnly, {}).changed, false);
    assert.equal(chunkToClient(undefined, {}).changed, false);
  });
});
