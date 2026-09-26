/**
 * @typedef {Object} ApiKeyConfig
 * @property {string} id
 * @property {string} api_key
 * @property {boolean} enabled
 */

/**
 * @typedef {Object} ModelLimits
 * @property {number} rpm
 * @property {number} rpd
 * @property {number} tpm
 */

/**
 * @typedef {Object} ModelConfig
 * @property {string} name
 * @property {number} priority
 * @property {ModelLimits} limits
 */

/**
 * @typedef {Object} PairState
 * @property {number[]} request_timestamps
 * @property {number} daily_count
 * @property {number} daily_reset_at
 * @property {[number, number][]} token_timestamps
 * @property {number} cooldown_until
 */

/**
 * @typedef {Object} SelectedPair
 * @property {ApiKeyConfig} key
 * @property {ModelConfig} model
 */

module.exports = {};
