const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractRetryDelaySeconds } = require('../client/errorParser');

describe('extractRetryDelaySeconds', () => {
  it('parses "Please retry in Xs" message', () => {
    assert.equal(
      extractRetryDelaySeconds({ error: { message: 'Quota exceeded. Please retry in 23.74395031s.' } }),
      23.74395031
    );
  });
  it('prefers structured retryDelay', () => {
    assert.equal(
      extractRetryDelaySeconds({ error: { message: 'x', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42s' }] } }),
      42
    );
  });
  it('parses ms durations', () => {
    assert.equal(
      extractRetryDelaySeconds({ error: { message: 'q', details: [{ retryDelay: '1500ms' }] } }),
      1.5
    );
  });
  it('handles raw string', () => {
    assert.equal(extractRetryDelaySeconds('Please retry in 5s'), 5);
  });
  it('falls back to 30s', () => {
    assert.equal(extractRetryDelaySeconds({ error: { message: 'weird error' } }), 30);
    assert.equal(extractRetryDelaySeconds(null), 30);
  });
});
