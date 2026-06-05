#!/usr/bin/env node
'use strict';

/**
 * synapsys-status — report the live active domain set for the current session.
 *
 *   node synapsys-status.js [--session-id=<id>] [--prompt=<text>]
 *                           [--tool=<ToolName:args>]... [--json] [--no-color]
 *
 * Reads:
 *   - Domain registry: $HOME/.claude/synapsys/DOMAINS.md (Task 2)
 *   - Sticky state:    $HOME/.claude/synapsys/.state/sticky-domains.json (Task 5)
 *
 * Computes the active-domain set via classifier + sticky carry-over (Task 6)
 * and prints each domain with signal attribution:
 *   - which leaf's `signal_prompt` matched, or
 *   - which leaf's `signal_pretool` matched, or
 *   - "sticky-carry" when the entry is carried by hysteresis.
 *
 * Fail-open: missing registry/state, parse errors, unknown signals → still
 * exits 0 with "no active domains" (or whatever subset we could compute).
 */

const path = require('node:path');
const os = require('node:os');

const { makeFlag } = require('../lib/cli-args');
const { loadDomainRegistry } = require('../lib/domains');
const { loadStickyState } = require('../lib/sticky-state');
const { classifyActiveDomains, iterateLeafSignals } = require('../lib/classifier');
const { makePalette } = require('../lib/ansi-palette');

function parseArgs(argv) {
  const flag = makeFlag(argv);
  const tools = argv
    .filter((a) => a === '--tool' || a.startsWith('--tool='))
    .map((a) => (a.indexOf('=') === -1 ? '' : a.slice(a.indexOf('=') + 1)))
    .filter(Boolean);
  return {
    sessionId: typeof flag('session-id') === 'string' ? flag('session-id') : 'default',
    prompt: typeof flag('prompt') === 'string' ? flag('prompt') : '',
    tools,
    json: !!flag('json'),
    noColor: !!flag('no-color') || process.env.NO_COLOR === '1' || !process.stdout.isTTY,
  };
}

/**
 * For each active domain, work out *why* it is active.
 *
 * Priority order:
 *   1. signal_prompt match  → "prompt: /<re>/"
 *   2. signal_pretool match → "pretool: /<re>/ on <tool>"
 *   3. sticky carry         → "sticky-carry"
 *
 * @returns {Map<string, { kind: 'prompt'|'pretool'|'sticky', detail: string }>}
 */
function findPromptAttribution(leaf, prompt) {
  if (!prompt) return null;
  const patterns = Array.isArray(leaf.signal_prompt) ? leaf.signal_prompt : [];
  for (const re of patterns) {
    if (re && typeof re.test === 'function' && re.test(prompt)) {
      return { kind: 'prompt', detail: `signal_prompt ${re}` };
    }
  }
  return null;
}

function findPretoolAttribution(leaf, tools) {
  const patterns = Array.isArray(leaf.signal_pretool) ? leaf.signal_pretool : [];
  for (const re of patterns) {
    if (!re || typeof re.test !== 'function') continue;
    const hit = tools.find((t) => typeof t === 'string' && re.test(t));
    if (hit) return { kind: 'pretool', detail: `signal_pretool ${re} on ${hit}` };
  }
  return null;
}

function setIfAbsent(map, keys, value) {
  for (const k of keys) if (!map.has(k)) map.set(k, value);
}

function stickyAttribution(domain, stickySession) {
  const entry = stickySession && stickySession[domain];
  const isSticky = entry && entry.sticky === true;
  return { kind: 'sticky', detail: isSticky ? 'sticky-carry' : 'carried' };
}

function attributeSignals(attribution, active, registry, prompt, tools) {
  for (const { rootName, leafName, leaf } of iterateLeafSignals(registry)) {
    const leafKey = `${rootName}:${leafName}`;
    if (!active.has(rootName) && !active.has(leafKey)) continue;
    const a = findPromptAttribution(leaf, prompt) || findPretoolAttribution(leaf, tools);
    if (a) setIfAbsent(attribution, [leafKey, rootName], a);
  }
}

function attribute({ active, registry, prompt, tools, stickySession }) {
  const attribution = new Map();
  attributeSignals(attribution, active, registry, prompt, tools);
  for (const domain of active) {
    if (!attribution.has(domain)) attribution.set(domain, stickyAttribution(domain, stickySession));
  }
  return attribution;
}

function safeLoadRegistry(home) {
  try {
    return loadDomainRegistry({ home });
  } catch (_) {
    return { roots: new Map() };
  }
}

function safeLoadSticky(stickyPath) {
  try {
    return loadStickyState({ filePath: stickyPath });
  } catch (_) {
    return {};
  }
}

// Read-only: mirror the hook's non-prompt path so the CLI never advances streaks.
function safeClassify({ prompt, recentToolCalls, registry, stickyState, sessionId }) {
  try {
    const active = classifyActiveDomains({ prompt, recentToolCalls, registry });
    const session = (stickyState && stickyState[sessionId]) || {};
    for (const domain of Object.keys(session)) {
      if (session[domain] && session[domain].sticky === true) active.add(domain);
    }
    return active;
  } catch (_) {
    return new Set();
  }
}

function makeColors(noColor) {
  return makePalette(noColor);
}

function emitJson(sessionId, active, attribution) {
  const sortedActive = [...active].sort();
  process.stdout.write(
    `${JSON.stringify(
      {
        sessionId,
        active: sortedActive,
        attribution: sortedActive.map((d) => ({
          domain: d,
          ...(attribution.get(d) || { kind: 'unknown', detail: '' }),
        })),
      },
      null,
      2
    )}\n`
  );
}

function emitHuman(opts, active, attribution, C) {
  if (active.size === 0) {
    process.stdout.write(`${C.dim('no active domains')}\n`);
    return;
  }
  process.stdout.write(`${C.bold('Active domains')} ${C.dim('·')} session=${opts.sessionId}\n`);
  for (const domain of [...active].sort()) {
    const a = attribution.get(domain) || { kind: 'unknown', detail: '' };
    process.stdout.write(`  ${C.green(domain)}  ${C.dim('—')} ${C.magenta(a.kind)}: ${a.detail}\n`);
  }
}

function main(argv) {
  const opts = parseArgs(argv);
  const home = process.env.SYNAPSYS_HOME || process.env.HOME || os.homedir();
  const stickyPath = path.join(home, '.claude', 'synapsys', '.state', 'sticky-domains.json');

  const registry = safeLoadRegistry(home);
  const stickyState = safeLoadSticky(stickyPath);
  const active = safeClassify({
    prompt: opts.prompt,
    recentToolCalls: opts.tools,
    registry,
    stickyState,
    sessionId: opts.sessionId,
  });

  const stickySession = (stickyState && stickyState[opts.sessionId]) || {};
  const attribution = attribute({
    active,
    registry,
    prompt: opts.prompt,
    tools: opts.tools,
    stickySession,
  });

  if (opts.json) {
    emitJson(opts.sessionId, active, attribution);
    return 0;
  }

  emitHuman(opts, active, attribution, makeColors(opts.noColor));
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (_) {
    // Last-resort fail-open.
    process.stdout.write('no active domains\n');
    process.exit(0);
  }
}

module.exports = { parseArgs, attribute, main };
