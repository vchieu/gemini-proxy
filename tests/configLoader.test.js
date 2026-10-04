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

  it('defaults to translate when upstream_mode absent', () => {
    const dir = makeTmpConfig({});
    try {
      assert.equal(loadConfig(dir).settings.upstream_mode, 'translate');
    } finally {
      rmTmp(dir);
    }
  });

  it('accepts upstream_mode: openai_compat', () => {
    const dir = makeTmpConfig({ upstream_mode: 'openai_compat' });
    try {
      assert.equal(loadConfig(dir).settings.upstream_mode, 'openai_compat');
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
      rmTmp(dir);
    }
  });
});
