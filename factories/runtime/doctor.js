'use strict';

/**
 * doctor.js — codex hook-trust report (C9: untrusted hooks are SILENTLY
 * skipped, so the whole enforcement layer can be off with zero signal).
 *
 * Parses `$CODEX_HOME/config.toml` `[hooks.state]` entries and compares them
 * against each plugin's hooks.json. Hash comparison uses the source-verified
 * normalized-identity formula (ground truth §2.8.4) and is BEST-EFFORT: the
 * formula is read from `main` source, not bit-exact-verified on 0.142.5, so
 * 'modified' verdicts are advisory. This module only ever READS trust state —
 * scripting `trusted_hash` writes is forbidden (gate-bypass anti-pattern).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** CamelCase hook event → codex snake-case identity label (§2.3.1). */
function snakeEventName(event) {
  return String(event)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeHandler(handler) {
  return {
    async: handler.async === true,
    command:
      process.platform === 'win32' && handler.commandWindows
        ? handler.commandWindows
        : handler.command,
    statusMessage: handler.statusMessage == null ? null : handler.statusMessage,
    timeout: typeof handler.timeout === 'number' ? handler.timeout : 600,
    type: handler.type || 'command',
  };
}

/** Best-effort normalized-identity hash (`sha256:…`) for one hook handler. */
function computeHookHash(eventName, matcher, handlers) {
  const identity = {
    event_name: snakeEventName(eventName),
    matcher: matcher == null ? '' : matcher,
    hooks: handlers.map(normalizeHandler),
  };
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(identity)).digest('hex')}`;
}

const STATE_HEADER_RE = /^\[hooks\.state\."(.*)"\]\s*$/;

/** Parse the `[hooks.state."<key>"]` tables out of a config.toml text. */
function parseHooksState(tomlText) {
  const state = new Map();
  let current = null;
  for (const rawLine of String(tomlText).split('\n')) {
    const line = rawLine.trim();
    const header = line.match(STATE_HEADER_RE);
    if (header) {
      current = { trustedHash: null, enabled: true };
      state.set(header[1], current);
      continue;
    }
    if (line.startsWith('[')) {
      current = null;
      continue;
    }
    if (!current) continue;
    const hash = line.match(/^trusted_hash\s*=\s*"(.+)"\s*$/);
    if (hash) {
      current.trustedHash = hash[1];
      continue;
    }
    const enabled = line.match(/^enabled\s*=\s*(true|false)\s*$/);
    if (enabled) current.enabled = enabled[1] === 'true';
  }
  return state;
}

/**
 * Expected `<keySource>:<snake_event>:<matcherIdx>:<handlerIdx>` entries for
 * one hooks.json, each with its best-effort identity hash (ground truth
 * §2.1.4 key format).
 */
function expectedHookEntries(hooksJson, keySource) {
  const entries = [];
  const events = (hooksJson && hooksJson.hooks) || {};
  for (const [event, matchers] of Object.entries(events)) {
    if (!Array.isArray(matchers)) continue;
    matchers.forEach((matcherEntry, matcherIdx) => {
      const handlers = Array.isArray(matcherEntry.hooks) ? matcherEntry.hooks : [];
      handlers.forEach((handler, handlerIdx) => {
        entries.push({
          key: `${keySource}:${snakeEventName(event)}:${matcherIdx}:${handlerIdx}`,
          event,
          matcherIdx,
          handlerIdx,
          hash: computeHookHash(event, matcherEntry.matcher, [handler]),
        });
      });
    });
  }
  return entries;
}

function statusFor(entry, state) {
  const stored = state.get(entry.key);
  if (!stored || !stored.trustedHash) return 'untrusted';
  if (stored.enabled === false) return 'disabled';
  return stored.trustedHash === entry.hash ? 'trusted' : 'modified';
}

/**
 * Trust report for one plugin's hooks.json against a parsed hooks.state map.
 * Only trusted hooks execute — untrusted/modified/disabled all mean the gate
 * is OFF (§2.8.1).
 */
function reportPlugin({ plugin, marketplace, hooksJsonPath, state }) {
  const keySource = `${plugin}@${marketplace}:hooks/hooks.json`;
  let hooksJson;
  try {
    hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  } catch (err) {
    return { plugin, error: `cannot read ${hooksJsonPath}: ${err.message}`, entries: [] };
  }
  const entries = expectedHookEntries(hooksJson, keySource).map((entry) => ({
    ...entry,
    status: statusFor(entry, state),
  }));
  const counts = { trusted: 0, modified: 0, untrusted: 0, disabled: 0 };
  for (const entry of entries) counts[entry.status] += 1;
  const off = entries.length - counts.trusted;
  const summary =
    off > 0
      ? `${off}/${entries.length} ${plugin} hooks UNTRUSTED — gates are OFF. Review in /hooks or relaunch with --dangerously-bypass-hook-trust`
      : `${entries.length}/${entries.length} ${plugin} hooks trusted`;
  return { plugin, marketplace, total: entries.length, ...counts, entries, summary };
}

/**
 * Trust report across plugins.
 *
 * @param {object} options
 * @param {string} [options.codexHome] - defaults to $CODEX_HOME or ~/.codex
 * @param {Array<{plugin: string, marketplace: string, hooksJsonPath: string}>} options.plugins
 */
function report({ codexHome, plugins }) {
  const home = codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  let state = new Map();
  let configError = null;
  try {
    state = parseHooksState(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'));
  } catch (err) {
    configError = `cannot read ${path.join(home, 'config.toml')}: ${err.message}`;
  }
  return {
    codexHome: home,
    configError,
    plugins: (plugins || []).map((spec) => reportPlugin({ ...spec, state })),
  };
}

module.exports = {
  snakeEventName,
  canonicalJson,
  computeHookHash,
  parseHooksState,
  expectedHookEntries,
  reportPlugin,
  report,
};
