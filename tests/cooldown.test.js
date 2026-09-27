const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isAvailable } = require('../state/cooldown');
const { StateStore } = require('../state/store');
const { nextMidnightPacific } = require('../utils/time');

function blank(over = {}) {
  return {
    request_timestamps: [],
    daily_count: 0,
    daily_reset_at: nextMidnightPacific(Date.now()),
    token_timestamps: [],
    cooldown_until: 0,
    ...over,
  };
}
const limits = { rpm: 5, rpd: 20, tpm: 250000 };

describe('isAvailable', () => {
  it('fresh pair is available', () => {
    assert.equal(isAvailable(blank(), limits, Date.now(), 1000), true);
  });
  it('cooldown blocks', () => {
    const st = blank({ cooldown_until: Date.now() + 10000 });
    assert.equal(isAvailable(st, limits, Date.now(), 10), false);
  });
  it('RPM threshold blocks', () => {
    const now = Date.now();
    const st = blank({ request_timestamps: [now - 1000, now - 2000, now - 3000, now - 4000, now - 5000] });
    assert.equal(isAvailable(st, limits, now, 10), false);
  });
  it('RPM ignores old timestamps', () => {
    const now = Date.now();
    const st = blank({ request_timestamps: [now - 61000, now - 62000, now - 63000, now - 64000, now - 65000] });
    assert.equal(isAvailable(st, limits, now, 10), true);
  });
  it('RPD threshold blocks', () => {
    const st = blank({ daily_count: 20 });
    assert.equal(isAvailable(st, limits, Date.now(), 10), false);
  });
  it('RPD resets after daily_reset_at (PT)', () => {
    const now = Date.now();
    const store = new StateStore(null);
    store.resetDailyIfNeeded('key-1', 'm', now - 1000); // set daily_reset_at trong quá khứ
    const st = store.get('key-1', 'm');
    st.daily_count = 20;
    st.daily_reset_at = now - 1000; // quá khứ → cần reset
    store.resetDailyIfNeeded('key-1', 'm', now);
    assert.equal(st.daily_count, 0);
    assert.ok(st.daily_reset_at > now);
    assert.equal(isAvailable(st, limits, now, 10), true);
  });
  it('TPM threshold blocks', () => {
    const now = Date.now();
    const st = blank({ token_timestamps: [[now - 1000, 249000]] });
    assert.equal(isAvailable(st, limits, now, 2000), false);
    assert.equal(isAvailable(st, limits, now, 500), true);
  });
});
