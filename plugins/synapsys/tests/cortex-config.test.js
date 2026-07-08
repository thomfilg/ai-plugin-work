'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, isKillSwitchOn } = require('../lib/cortex-config.js');

/**
 * Build a temporary fake $HOME containing (optionally) a
 * ~/.claude/synapsys/config.yaml file, returning the home dir path.
 */
function makeHome(yaml) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-config-'));
  if (yaml !== undefined) {
    const dir = path.join(home, '.claude', 'synapsys');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.yaml'), yaml, 'utf8');
  }
  return home;
}

const DEFAULTS = {
  enabled: true,
  on_session_start: true,
  on_memory_fire: true,
  on_user_prompt: false,
  max_age_days: 180,
  max_results_per_query: 5,
  max_chars_per_memory: 500,
  max_keywords: 6,
};

// --- Deliverable 1.1: loadConfig ------------------------------------------

test('loadConfig returns the eight documented defaults when no file exists', () => {
  const home = makeHome(); // no config.yaml written
  const cfg = loadConfig({ home, env: {} });
  assert.deepEqual(cfg, DEFAULTS);
});

test('loadConfig override: a fixture YAML overrides only the keys it declares', () => {
  const home = makeHome('cortex_auto_recall:\n  max_age_days: 30\n  enabled: false\n');
  const cfg = loadConfig({ home, env: {} });
  assert.equal(cfg.max_age_days, 30, 'declared key is overridden');
  assert.equal(cfg.enabled, false, 'declared key is overridden');
  // Undeclared keys keep their defaults.
  assert.equal(cfg.on_session_start, true);
  assert.equal(cfg.max_results_per_query, 5);
  assert.equal(cfg.max_chars_per_memory, 500);
  assert.equal(cfg.max_keywords, 6);
  assert.equal(cfg.on_memory_fire, true);
  assert.equal(cfg.on_user_prompt, false);
});

test('loadConfig types booleans and numbers (not strings)', () => {
  const home = makeHome('cortex_auto_recall:\n  max_age_days: 30\n  enabled: false\n');
  const cfg = loadConfig({ home, env: {} });
  assert.equal(typeof cfg.max_age_days, 'number', 'max_age_days must be a number');
  assert.equal(typeof cfg.enabled, 'boolean', 'enabled must be a boolean');
  assert.equal(typeof cfg.on_user_prompt, 'boolean');
  assert.equal(typeof cfg.max_keywords, 'number');
});

// --- Deliverable 1.2: isKillSwitchOn --------------------------------------

test('isKillSwitchOn returns true for literal off', () => {
  assert.equal(isKillSwitchOn({ SYNAPSYS_CORTEX_AUTO_RECALL: 'off' }), true);
});

test('isKillSwitchOn is case-insensitive on off', () => {
  assert.equal(isKillSwitchOn({ SYNAPSYS_CORTEX_AUTO_RECALL: 'OFF' }), true);
});

test('isKillSwitchOn returns false when unset', () => {
  assert.equal(isKillSwitchOn({}), false);
});

test('isKillSwitchOn returns false for any other value', () => {
  assert.equal(isKillSwitchOn({ SYNAPSYS_CORTEX_AUTO_RECALL: 'on' }), false);
});
