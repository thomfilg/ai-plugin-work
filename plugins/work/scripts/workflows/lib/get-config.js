/**
 * get-config.js
 *
 * Lightweight config resolver for hooks and agents.
 * Resolution: process.env[key] → config[key] → undefined
 *
 * Usage:
 *   const getConfig = require('./get-config');
 *   const tasksBase = getConfig('TASKS_BASE');       // env → config → undefined
 *   const tasksBase = getConfig.require('TASKS_BASE'); // env → config → throw
 */

const path = require('path');

let _config;
let _configLoaded = false;

function loadConfig() {
  if (_configLoaded) return _config;
  _configLoaded = true;
  const configPath = path.join(__dirname, 'config');
  try {
    _config = require(configPath);
  } catch (err) {
    // Only swallow MODULE_NOT_FOUND for config.js itself, not its transitive deps
    if (err?.code === 'MODULE_NOT_FOUND' && err.message?.includes(configPath)) {
      _config = null;
    } else {
      throw err;
    }
  }
  return _config;
}

/**
 * Get a config value. Env var always wins over config.js.
 * @param {string} key
 * @returns {string|undefined}
 */
function getConfig(key) {
  return process.env[key] || loadConfig()?.[key] || undefined;
}

/**
 * Get a config value or throw if missing.
 * @param {string} key
 * @returns {string}
 */
getConfig.require = function (key) {
  const val = getConfig(key);
  if (!val)
    throw new Error(
      `${key} not configured. Set it as env var or ensure lib/config.js is loadable.`
    );
  return val;
};

/**
 * Get a config value, exit(0) if missing (fail-open for hooks).
 * @param {string} key
 * @returns {string}
 */
getConfig.orExit = function (key) {
  const val = getConfig(key);
  if (!val) process.exit(0);
  return val;
};

module.exports = getConfig;
