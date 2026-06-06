#!/usr/bin/env node
'use strict';

/**
 * synapsys-explain — per-memory trigger debugger CLI for synapsys (GH-443).
 *
 *   node synapsys-explain.js --event=UserPromptSubmit --prompt="<text>"
 *   node synapsys-explain.js --event=PreToolUse --tool=Edit --tool-input='{...}'
 *   node synapsys-explain.js --stdin   (reads raw hook event JSON from stdin)
 *   node synapsys-explain.js [...] --only=name1,name2 --verbose --store=<name|path>
 *
 * Exit codes:
 *   0 — Always when configuration is valid (regardless of fire count).
 *   2 — Misconfiguration: invalid stdin JSON, invalid --tool-input JSON,
 *       unknown --store, malformed --event.
 *
 * Output:
 *   Default → compact table `Memory | Fired (✓/✗) | Reason` with footer
 *             `N/M memories fired.`
 *   --verbose → per-memory detail blocks (events list, trigger regex,
 *               matched alternative/substring or gate label + first 3 body lines).
 */

const fs = require('node:fs');
const path = require('node:path');

const { makeFlag } = require(path.join(__dirname, '..', 'lib', 'cli-args'));
const memoryStore = require(path.join(__dirname, '..', 'lib', 'memory-store'));
const matcher = require(path.join(__dirname, '..', 'lib', 'matcher'));
const { buildActiveDomains } = require(path.join(__dirname, '..', 'lib', 'active-domains'));
const { resolveSessionId: ledgerResolveSessionId } = require(
  path.join(__dirname, '..', 'lib', 'inject-ledger')
);

const VALID_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'SessionStart', 'Stop']);

const REASON_COL_MAX = 24;

function die(msg, code = 2) {
  process.stderr.write(`synapsys-explain: ${msg}\n`);
  process.exit(code);
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseStdinPayload(raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    die(`invalid stdin JSON: ${err.message}`, 2);
  }
}

function parseToolInput(raw) {
  if (raw === undefined || raw === '' || raw === true) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    die(`invalid --tool-input JSON: ${err.message}`, 2);
  }
}

function loadStore(storeFlag, cwd) {
  const stores = memoryStore.discoverStores(cwd);
  if (!storeFlag || storeFlag === true) {
    return stores;
  }
  // Match by kind name first, then by absolute path.
  const byName = stores.filter((s) => s.kind === storeFlag);
  if (byName.length) return byName;
  const abs = path.resolve(storeFlag);
  const byPath = stores.filter((s) => path.resolve(s.dir) === abs);
  if (byPath.length) return byPath;
  die(`unknown --store "${storeFlag}" (no matching discovered store)`, 2);
}

function loadMemories(stores) {
  const all = [];
  for (const s of stores) {
    all.push(...memoryStore.listMemoriesFromStore(s));
  }
  return all;
}

function evaluateMemory(memory, event, payload, activeDomains) {
  // Domain gate must run BEFORE per-event trigger checks, mirroring
  // selectForEvent in the dispatcher hook. Otherwise explain reports
  // memories as fired that the hook would skip via isDomainMismatch.
  if (activeDomains && matcher.isDomainMismatch(memory, activeDomains)) {
    return { fired: false, reason: 'domain-mismatch' };
  }
  if (event === 'UserPromptSubmit') {
    return matcher.matchPrompt(memory, payload.prompt || '');
  }
  if (event === 'PreToolUse') {
    return matcher.matchPreTool(memory, payload);
  }
  if (event === 'SessionStart') {
    return matcher.matchSession(memory);
  }
  if (event === 'Stop') {
    return matcher.matchStop(memory);
  }
  return { fired: false, reason: 'events-exclude' };
}

// Read-only activeDomains resolver — uses the same shared helper as the
// dispatcher so explain's domain gate agrees with what selectForEvent
// would do at injection time. Passes the inject-ledger session resolver
// so sticky-state is read under the SAME bucket the dispatcher writes
// to (without it, explain reads the 'default' bucket and disagrees with
// live hysteresis). `onPersistSticky` is omitted so the CLI never
// mutates sticky state (diagnostic-only).
function computeActiveDomainsForExplain(event, payload) {
  return buildActiveDomains(event, payload, { resolveSessionId: ledgerResolveSessionId });
}

function truncate(str, max) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

function renderTable(results) {
  const nameWidth = Math.max(6, ...results.map((r) => r.memory.name.length));
  const out = [];
  const header = `${'Memory'.padEnd(nameWidth)} | Fired | ${'Reason'.padEnd(REASON_COL_MAX)}`;
  out.push(header);
  out.push('-'.repeat(header.length));

  let fired = 0;
  for (const r of results) {
    const mark = r.result.fired ? '✓' : '✗';
    if (r.result.fired) fired++;
    const reason = r.result.fired ? '' : r.result.reason || '';
    out.push(
      `${r.memory.name.padEnd(nameWidth)} | ${mark}     | ${truncate(reason, REASON_COL_MAX).padEnd(REASON_COL_MAX)}`
    );
  }
  out.push('');
  out.push(`${fired}/${results.length} memories fired.`);
  return out.join('\n') + '\n';
}

function eventTriggerSource(memory, event) {
  if (event === 'UserPromptSubmit') return memory.triggerPrompt || '';
  if (event === 'PreToolUse') {
    const parts = [];
    if (memory.triggerPretool && memory.triggerPretool.length) {
      parts.push(`pretool: ${memory.triggerPretool.join(', ')}`);
    }
    if (memory.triggerPretoolContent && memory.triggerPretoolContent.length) {
      parts.push(`content: ${memory.triggerPretoolContent.join(', ')}`);
    }
    return parts.join(' | ');
  }
  if (event === 'SessionStart') return `trigger_session: ${memory.triggerSession}`;
  if (event === 'Stop') return '(unconditional on Stop)';
  return '';
}

const MATCHED_LABELS = [
  ['prompt_token', 'matched.prompt_token'],
  ['prompt_substring', 'matched.prompt_substring'],
  ['pretool_pattern', 'matched.pretool_pattern'],
  ['content_pattern', 'matched.content_pattern'],
  ['content_substring', 'matched.content_substring'],
  ['excluded_pattern', 'matched.excluded_pattern'],
];

function renderFiredBlock(matched) {
  const lines = ['  fired: ✓'];
  const m = matched || {};
  for (const [key, label] of MATCHED_LABELS) {
    if (m[key] !== undefined) lines.push(`  ${label}: ${m[key]}`);
  }
  return lines;
}

function renderNotFiredBlock(memory, reason, matched) {
  const lines = [`  fired: ✗  (gate: ${reason || 'unknown'})`];
  // Surface matched.* keys on suppressed results so reasons like
  // `exclude-matched` (GH-510) or `negative-excludes` (GH-445) show the
  // offending pattern alongside the gate label.
  const m = matched || {};
  for (const [key, label] of MATCHED_LABELS) {
    if (m[key] !== undefined) lines.push(`  ${label}: ${m[key]}`);
  }
  const bodyLines = (memory.body || '').split('\n').filter(Boolean).slice(0, 3);
  if (bodyLines.length) {
    lines.push('  body (first 3 lines):');
    for (const bl of bodyLines) lines.push(`    ${bl}`);
  }
  return lines;
}

function renderVerboseBlock(memory, result, event) {
  const lines = [`# ${memory.name}`];
  const eventsList = memory.events.map((e) => (e === event ? `${e} ✓` : e)).join(', ');
  lines.push(`  events: ${eventsList}`);
  const trig = eventTriggerSource(memory, event);
  if (trig) lines.push(`  trigger: ${trig}`);
  const body = result.fired
    ? renderFiredBlock(result.matched)
    : renderNotFiredBlock(memory, result.reason, result.matched);
  lines.push(...body);
  return lines.join('\n');
}

function renderVerbose(results, event) {
  const out = [];
  let fired = 0;
  for (const r of results) {
    if (r.result.fired) fired++;
    out.push(renderVerboseBlock(r.memory, r.result, event));
    out.push('');
  }
  out.push(`${fired}/${results.length} memories fired.`);
  return out.join('\n') + '\n';
}

function readStdinPayloadIfRequested(flag) {
  if (!flag('stdin')) return {};
  return parseStdinPayload(readStdinSync());
}

function resolveEvent(flag, stdinPayload) {
  const event = flag('event') || stdinPayload.hook_event_name || 'UserPromptSubmit';
  if (!VALID_EVENTS.has(event)) {
    die(`unknown --event "${event}" (expected one of ${[...VALID_EVENTS].join(', ')})`, 2);
  }
  return event;
}

function resolveToolInput(flag, stdinPayload) {
  if (flag('tool-input') !== undefined) return parseToolInput(flag('tool-input'));
  if (stdinPayload.tool_input !== undefined) return stdinPayload.tool_input;
  return undefined;
}

function parseOnlyList(flag) {
  const raw = flag('only');
  if (typeof raw !== 'string') return null;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function applyOnlyFilter(memories, only) {
  if (!only || !only.length) return memories;
  const names = new Set(memories.map((m) => m.name));
  for (const n of only) {
    if (!names.has(n)) {
      process.stderr.write(`synapsys-explain: --only name "${n}" not found in store\n`);
    }
  }
  const onlySet = new Set(only);
  return memories.filter((m) => onlySet.has(m.name));
}

function buildPayload(event, prompt, tool, toolInput, cwd) {
  return {
    hook_event_name: event,
    prompt: prompt === true ? '' : prompt || '',
    tool_name: tool === true ? '' : tool || '',
    tool_input: toolInput || {},
    cwd,
  };
}

function main() {
  const flag = makeFlag(process.argv.slice(2));
  const stdinPayload = readStdinPayloadIfRequested(flag);
  const event = resolveEvent(flag, stdinPayload);

  const cwd = flag('cwd') || stdinPayload.cwd || process.cwd();
  const prompt = flag('prompt') !== undefined ? flag('prompt') : stdinPayload.prompt;
  const tool = flag('tool') !== undefined ? flag('tool') : stdinPayload.tool_name;
  const toolInput = resolveToolInput(flag, stdinPayload);
  const verbose = !!flag('verbose');
  const only = parseOnlyList(flag);

  const stores = loadStore(flag('store'), cwd);
  const memories = applyOnlyFilter(loadMemories(stores), only);
  const payload = buildPayload(event, prompt, tool, toolInput, cwd);

  const activeDomains = computeActiveDomainsForExplain(event, payload);
  const results = memories.map((memory) => ({
    memory,
    result: evaluateMemory(memory, event, payload, activeDomains),
  }));

  const rendered = verbose ? renderVerbose(results, event) : renderTable(results);
  process.stdout.write(rendered);
  process.exit(0);
}

main();
