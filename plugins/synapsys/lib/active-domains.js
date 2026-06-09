'use strict';

/**
 * Shared active-domains resolver — single source of truth for the
 * dispatcher hook AND synapsys-explain. Builds the `activeDomains` set
 * that gates domain-tagged memories via isDomainMismatch, mirroring the
 * sticky-state hysteresis behavior across UserPromptSubmit / PreToolUse /
 * Stop / SessionStart events.
 *
 * The dispatcher's hot-path version (in hooks/synapsys.js) persists
 * sticky-state on UserPromptSubmit; this module's `readOnly` variant
 * never persists (used by explain — a diagnostic CLI must not mutate).
 *
 * Fail-open: any error → returns undefined so the caller falls back to
 * pre-classifier behavior (no domain gating).
 */

const { loadDomainRegistry } = require('./domains');
const { classifyActiveDomains, classifyWithSticky } = require('./classifier');
const { loadStickyState } = require('./sticky-state');

function readRecentToolCalls(payload) {
  if (Array.isArray(payload.recentToolCalls)) return payload.recentToolCalls;
  if (Array.isArray(payload.recent_tool_calls)) return payload.recent_tool_calls;
  return [];
}

// Serialize a PreToolUse invoking tool (tool_name + tool_input) into a
// single string so signal_pretool regexes match against the tool under
// execution. Returns null when not PreToolUse or no tool present.
function currentToolCallString(event, payload) {
  if (event !== 'PreToolUse') return null;
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  if (!toolName) return null;
  let inputStr = '';
  const input = payload.tool_input;
  if (input != null) {
    try {
      inputStr = typeof input === 'string' ? input : JSON.stringify(input);
    } catch {
      inputStr = '';
    }
  }
  return `${toolName} ${inputStr}`.trim();
}

function getRecentToolCallsWithCurrent(event, payload) {
  const base = readRecentToolCalls(payload);
  const cur = currentToolCallString(event, payload);
  return cur ? [cur, ...base] : base;
}

// Merge sticky-active domains for a session into a raw-active set
// without mutating streaks. Used for non-prompt events where hysteresis
// (which counts "prompts", not arbitrary hook turns) must not advance.
function mergeStickyActive(rawActive, stickyState, sessionId) {
  const merged = new Set(rawActive);
  const session = (stickyState && stickyState[sessionId]) || {};
  for (const domain of Object.keys(session)) {
    const entry = session[domain];
    if (entry && entry.sticky === true) merged.add(domain);
  }
  return merged;
}

// PreToolUse / Stop / SessionStart all read sticky carry-over without
// mutating streaks. SessionStart returns undefined because it has no
// prompt/tool signal yet — gating every domain-tagged memory against an
// empty set on a fresh session would block trigger_session memories
// before they ever get a chance to match. On PreToolUse and Stop we
// return the merged set as-is (possibly empty) so isDomainMismatch runs
// for domain-tagged memories — matching UserPromptSubmit's behavior so
// a domain-tagged memory cannot inject when the active intersection is
// empty just because the gate was silently skipped.
function passiveActiveDomains(event, payload, registry, stickyState, sessionId) {
  if (event === 'SessionStart') return undefined;
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  const recentToolCalls = getRecentToolCallsWithCurrent(event, payload);
  const rawActive = classifyActiveDomains({ prompt, recentToolCalls, registry });
  return mergeStickyActive(rawActive, stickyState, sessionId);
}

/**
 * Build the `activeDomains` set for a hook payload.
 *
 * @param {string} event   Hook event name.
 * @param {object} payload Hook payload (prompt / tool / session id).
 * @param {object} [opts]
 * @param {(state: object) => void} [opts.onPersistSticky] Optional callback
 *   invoked with the next sticky state on UserPromptSubmit (the dispatcher
 *   passes saveStickyState; explain omits it for read-only behavior).
 * @returns {Set<string> | undefined}
 */
function defaultResolveSessionId(payload) {
  return payload.session_id || payload.sessionId || 'default';
}

function resolveSessionIdSafe(opts, payload) {
  const resolve =
    typeof opts.resolveSessionId === 'function' ? opts.resolveSessionId : defaultResolveSessionId;
  try {
    return resolve(payload);
  } catch {
    return 'default';
  }
}

function activeDomainsForUserPrompt(payload, registry, stickyState, sessionId, opts) {
  const { activeDomains, nextStickyState } = classifyWithSticky({
    prompt: typeof payload.prompt === 'string' ? payload.prompt : '',
    recentToolCalls: getRecentToolCallsWithCurrent('UserPromptSubmit', payload),
    registry,
    stickyState,
    sessionId,
  });
  if (typeof opts.onPersistSticky === 'function') {
    try {
      opts.onPersistSticky(nextStickyState);
    } catch {
      // fail-open: persistence failures must not block injection
    }
  }
  return activeDomains;
}

function buildActiveDomains(event, payload, opts = {}) {
  try {
    const registry = loadDomainRegistry();
    if (!registry || !registry.roots || registry.roots.size === 0) return undefined;
    const sessionId = resolveSessionIdSafe(opts, payload);
    const stickyState = loadStickyState();
    if (event === 'UserPromptSubmit') {
      return activeDomainsForUserPrompt(payload, registry, stickyState, sessionId, opts);
    }
    return passiveActiveDomains(event, payload, registry, stickyState, sessionId);
  } catch {
    return undefined;
  }
}

module.exports = {
  buildActiveDomains,
  // Exported helpers (used by tests + dispatcher hook for backward compat).
  currentToolCallString,
  mergeStickyActive,
  passiveActiveDomains,
  getRecentToolCallsWithCurrent,
};
