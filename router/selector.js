const { isAvailable } = require('../state/cooldown');

// Round-robin cursor: modelName -> next start index trong danh sách keys.
const cursors = new Map();

function _resetRoundRobin() {
  cursors.clear();
}

/**
 * @param {ModelConfig[]} models
 * @param {ApiKeyConfig[]} keys
 * @param {StateStore} stateStore
 * @param {number} nowMs
 * @param {number} estimatedTokens
 * @param {SelectedPair[]} excludePairs  // các cặp đã thử và fail trong request hiện tại
 * @returns {SelectedPair | null}
 */
function selectPair(models, keys, stateStore, nowMs, estimatedTokens, excludePairs) {
  const now = Number(nowMs !== undefined ? nowMs : Date.now());
  const est = Number(estimatedTokens) || 0;
  const excluded = new Set((excludePairs || []).map((p) => `${p.key.id}::${p.model.name}`));

  const sortedModels = [...(models || [])].sort((a, b) => a.priority - b.priority);
  const enabledKeys = (keys || []).filter((k) => k.enabled !== false);
  if (sortedModels.length === 0 || enabledKeys.length === 0) return null;

  for (const model of sortedModels) {
    const n = enabledKeys.length;
    const start = cursors.get(model.name) || 0;
    for (let i = 0; i < n; i++) {
      const key = enabledKeys[(start + i) % n];
      const pairKey = `${key.id}::${model.name}`;
      if (excluded.has(pairKey)) continue;
      const st = stateStore.get(key.id, model.name);
      if (isAvailable(st, model.limits, now, est)) {
        // xoay cursor cho lần sau để dàn đều tải giữa các key
        cursors.set(model.name, (start + i + 1) % n);
        return { key, model };
      }
    }
  }
  return null;
}

module.exports = { selectPair, _resetRoundRobin };
