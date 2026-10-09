const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../config/loader');

// Tạo thư mục config tạm với keys/models/config hợp lệ.
function makeTmpConfig(configObj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-cfg-'));
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify({
    keys: [{ id: 'key-1', api_key: 'k1', enabled: true }],
  }));
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({
    models: [{ name: 'm', priority: 1, limits: { rpm: 5, rpd: 20, tpm: 250000 } }],
  }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(configObj || {}));
  return dir;
}

function rmTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('config/loader upstream_mode', () => {
  const originalUpstreamMode = process.env.UPSTREAM_MODE;

  afterEach(() => {
    // Env phải được restore giữa các test — nếu không test sau sẽ bị "lây" mode.
    if (originalUpstreamMode === undefined) delete process.env.UPSTREAM_MODE;
    else process.env.UPSTREAM_MODE = originalUpstreamMode;
  });

  it('defaults to openai_compat when upstream_mode absent', () => {
    const dir = makeTmpConfig({});
    try {
      assert.equal(loadConfig(dir).settings.upstream_mode, 'openai_compat');
    } finally {
      rmTmp(dir);
    }
  });

  it('accepts upstream_mode: translate (legacy)', () => {
    const dir = makeTmpConfig({ upstream_mode: 'translate' });
    try {
      assert.equal(loadConfig(dir).settings.upstream_mode, 'translate');
    } finally {
      rmTmp(dir);
    }
  });

  it('throws on invalid upstream_mode', () => {
    const dir = makeTmpConfig({ upstream_mode: 'nope' });
    try {
      assert.throws(() => loadConfig(dir), /upstream_mode must be one of translate, openai_compat/);
    } finally {
      rmTmp(dir);
    }
  });

  it('env UPSTREAM_MODE overrides config file', () => {
    const dir = makeTmpConfig({ upstream_mode: 'translate' });
    try {
      process.env.UPSTREAM_MODE = 'openai_compat';
      assert.equal(loadConfig(dir).settings.upstream_mode, 'openai_compat');
    } finally {
      rmTmp(dir);
    }
  });

  it('throws when env UPSTREAM_MODE is invalid', () => {
    const dir = makeTmpConfig({ upstream_mode: 'translate' });
    try {
      process.env.UPSTREAM_MODE = 'bogus';
      assert.throws(() => loadConfig(dir), /upstream_mode must be one of/);
    } finally {
      delete process.env.UPSTREAM_MODE;
      rmTmp(dir);
    }
  });

  it('throws when default_cooldown_seconds is negative or non-number (L3)', () => {
    const dir = makeTmpConfig({ default_cooldown_seconds: -5 });
    try {
      assert.throws(() => loadConfig(dir), /default_cooldown_seconds must be a non-negative number/);
    } finally {
      rmTmp(dir);
    }
  });
});

describe('config/loader host (H2 — mặc định chỉ bind loopback)', () => {
  it('defaults host to 127.0.0.1 when absent', () => {
    const dir = makeTmpConfig({});
    try {
      assert.equal(loadConfig(dir).settings.host, '127.0.0.1');
    } finally {
      rmTmp(dir);
    }
  });

  it('accepts explicit host (vd 0.0.0.0 để expose ra LAN)', () => {
    const dir = makeTmpConfig({ host: '0.0.0.0' });
    try {
      assert.equal(loadConfig(dir).settings.host, '0.0.0.0');
    } finally {
      rmTmp(dir);
    }
  });

  it('throws on empty or non-string host', () => {
    for (const bad of ['', '   ', 42, null]) {
      const dir = makeTmpConfig({ host: bad });
      try {
        assert.throws(() => loadConfig(dir), /host must be a non-empty string/, `host=${JSON.stringify(bad)} must throw`);
      } finally {
        rmTmp(dir);
      }
    }
  });

  it('exports VALID_UPSTREAM_MODES (PLAN-openai-compat-migration Phase 2.2)', () => {
    const { VALID_UPSTREAM_MODES } = require('../config/loader');
    assert.deepEqual(VALID_UPSTREAM_MODES, ['translate', 'openai_compat']);
  });
});
