const fs = require('fs');
const path = require('path');

const VALID_STRATEGIES = ['round_robin_key_then_model', 'priority_model_first'];
const VALID_UPSTREAM_MODES = ['translate', 'openai_compat'];
const DEFAULT_LIMITS = { rpm: 5, rpd: 20, tpm: 250000 };

/**
 * Đọc và validate 3 file config. Ném lỗi nếu thiếu field bắt buộc
 * hoặc key/model trùng id/name.
 * @param {string} configDir thư mục chứa keys.json, models.json, config.json
 * @returns {{ keys: ApiKeyConfig[], models: ModelConfig[], settings: object }}
 */
function loadConfig(configDir) {
  const dir = configDir || path.join(__dirname);
  const keysPath = path.join(dir, 'keys.json');
  const modelsPath = path.join(dir, 'models.json');
  const configPath = path.join(dir, 'config.json');

  for (const p of [keysPath, modelsPath, configPath]) {
    if (!fs.existsSync(p)) throw new Error(`Missing config file: ${p}`);
  }

  let keysRaw, modelsRaw, settingsRaw;
  try {
    keysRaw = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
    modelsRaw = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
    settingsRaw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`Invalid JSON in config: ${e.message}`);
  }

  // ---- keys ----
  if (!Array.isArray(keysRaw.keys)) throw new Error('keys.json: "keys" must be an array');
  const seenKeyId = new Set();
  const keys = keysRaw.keys.map((k, i) => {
    if (!k.id || typeof k.id !== 'string') throw new Error(`keys.json: keys[${i}].id must be a non-empty string`);
    if (!k.api_key || typeof k.api_key !== 'string') throw new Error(`keys.json: keys[${i}].api_key must be a non-empty string`);
    if (seenKeyId.has(k.id)) throw new Error(`keys.json: duplicate key id "${k.id}"`);
    seenKeyId.add(k.id);
    return { id: k.id, api_key: k.api_key, enabled: k.enabled !== false };
  });
  if (keys.length === 0) throw new Error('keys.json: at least one key is required');

  // ---- models ----
  if (!Array.isArray(modelsRaw.models)) throw new Error('models.json: "models" must be an array');
  const seenModel = new Set();
  const models = modelsRaw.models.map((m, i) => {
    if (!m.name || typeof m.name !== 'string') throw new Error(`models.json: models[${i}].name must be a non-empty string`);
    if (seenModel.has(m.name)) throw new Error(`models.json: duplicate model name "${m.name}"`);
    seenModel.add(m.name);
    const priority = m.priority !== undefined ? m.priority : i + 1;
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
      throw new Error(`models.json: models[${i}].priority must be a number`);
    }
    const lim = m.limits || {};
    const limits = {
      rpm: lim.rpm !== undefined ? lim.rpm : DEFAULT_LIMITS.rpm,
      rpd: lim.rpd !== undefined ? lim.rpd : DEFAULT_LIMITS.rpd,
      tpm: lim.tpm !== undefined ? lim.tpm : DEFAULT_LIMITS.tpm,
    };
    for (const f of ['rpm', 'rpd', 'tpm']) {
      if (typeof limits[f] !== 'number' || !(limits[f] > 0)) {
        throw new Error(`models.json: models[${i}].limits.${f} must be a positive number`);
      }
    }
    return { name: m.name, priority, limits };
  });
  if (models.length === 0) throw new Error('models.json: at least one model is required');
  models.sort((a, b) => a.priority - b.priority);

  // ---- settings ----
  const settings = {
    port: settingsRaw.port !== undefined ? settingsRaw.port : 8787,
    // H2: mặc định chỉ bind loopback — proxy local không auth, bind 0.0.0.0 sẽ
    // cho cả LAN/Wi-Fi dùng được key của bạn. Muốn expose ra mạng phải set chủ động.
    host: settingsRaw.host !== undefined ? settingsRaw.host : '127.0.0.1',
    strategy: settingsRaw.strategy || 'round_robin_key_then_model',
    state_file: settingsRaw.state_file || './data/state.json',
    log_level: settingsRaw.log_level || 'info',
    request_timeout_ms: settingsRaw.request_timeout_ms !== undefined ? settingsRaw.request_timeout_ms : 60000,
    max_fallback_attempts: settingsRaw.max_fallback_attempts !== undefined ? settingsRaw.max_fallback_attempts : 12,
    respect_agent_model: settingsRaw.respect_agent_model === true,
    default_cooldown_seconds: settingsRaw.default_cooldown_seconds !== undefined ? settingsRaw.default_cooldown_seconds : 30,
    upstream_mode: (process.env.UPSTREAM_MODE || settingsRaw.upstream_mode || 'openai_compat').trim(),
  };
  if (!VALID_UPSTREAM_MODES.includes(settings.upstream_mode)) {
    throw new Error(`config.json: upstream_mode must be one of ${VALID_UPSTREAM_MODES.join(', ')}`);
  }
  if (typeof settings.port !== 'number' || !(settings.port > 0 && settings.port < 65536)) {
    throw new Error('config.json: port must be 1..65535');
  }
  if (typeof settings.host !== 'string' || settings.host.trim() === '') {
    throw new Error('config.json: host must be a non-empty string (vd "127.0.0.1", "0.0.0.0")');
  }
  if (!VALID_STRATEGIES.includes(settings.strategy)) {
    throw new Error(`config.json: strategy must be one of ${VALID_STRATEGIES.join(', ')}`);
  }
  if (typeof settings.request_timeout_ms !== 'number' || !(settings.request_timeout_ms > 0)) {
    throw new Error('config.json: request_timeout_ms must be positive');
  }
  if (typeof settings.max_fallback_attempts !== 'number' || !(settings.max_fallback_attempts >= 1)) {
    throw new Error('config.json: max_fallback_attempts must be >= 1');
  }
  if (typeof settings.default_cooldown_seconds !== 'number' || !(settings.default_cooldown_seconds >= 0)) {
    throw new Error('config.json: default_cooldown_seconds must be a non-negative number');
  }

  return { keys, models, settings };
}

module.exports = { loadConfig, VALID_STRATEGIES, VALID_UPSTREAM_MODES, DEFAULT_LIMITS };
