#!/usr/bin/env node

/**
 * brief-next.js
 *
 * Self-paced runner for the `brief` step. Thin orchestrator only — every
 * phase (inputs / overlap / draft / validate / memorize / done) lives in
 * its own module under `lib/phases/`, registered via `lib/phase-registry.js`.
 * The dispatcher pattern mirrors `check2/lib/step-registry.js`.
 *
 * Per invocation:
 *   1. Resolve ticket context (tasks dir, manifest, linked siblings, memory plugin).
 *   2. Look up the current phase from `brief-phase.json` via `brief-phase-state.js`.
 *   3. Ask the registered phase handler whether the phase is ready to advance.
 *        validate(ctx) → { ok, errors?, summary? }
 *   4. If ok and the phase has a successor: record evidence + transition.
 *      If errors are present: emit a block prefix on the response.
 *      Otherwise: just print the current phase's instructions.
 *   5. Print the header + (possibly blocked) phase instructions.
 *
 * Exit codes: 0 = phase progressed or waiting, 2 = phase blocked.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BRIEF_PHASE_CLI = path.resolve(__dirname, 'brief-phase-state.js');

const { BRIEF_INITIAL_PHASE } = require('./brief-phase-registry');
const { getPhase } = require('./lib/phase-registry');
const { loadMemoryPluginCandidates } = require('./lib/memory-plugin-config');

let logNextScriptEvent;
try {
  ({ logNextScriptEvent } = require('../lib/next-script-log'));
} catch {
  logNextScriptEvent = () => {};
}

let config;
try {
  config = require('../lib/config');
} catch {
  config = null;
}

// ─── Path + env helpers ────────────────────────────────────────────────────

function resolveTasksBase() {
  return (
    process.env.TASKS_BASE ||
    (config && config.TASKS_BASE) ||
    path.join(require('node:os').homedir(), 'worktrees', 'tasks')
  );
}

function resolveWorktreeRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

function die(msg) {
  process.stderr.write(`brief-next: ${msg}\n`);
  process.exit(2);
}

// ─── Token snapshot/remint (mirrors task-next.js) ──────────────────────────

let _companionTokenSnapshot = null;

function snapshotCompanionToken(scriptBasename, ticketId) {
  try {
    const dir = process.env.CLAUDE_WRITE_TOKEN_DIR || '/tmp/.claude-write-tokens';
    // Per-ticket keyed path first (matches what the PreToolUse hook mints
    // post commit 2f37f34b). Fall back to the legacy unkeyed path for
    // backwards-compat (e.g. older hook versions still in transit).
    const bareTicket = ticketId ? String(ticketId).split('/')[0] : null;
    const keyed = bareTicket ? path.join(dir, `${scriptBasename}.${bareTicket}`) : null;
    const legacy = path.join(dir, scriptBasename);
    const file = keyed && fs.existsSync(keyed) ? keyed : fs.existsSync(legacy) ? legacy : null;
    if (!file) return;
    _companionTokenSnapshot = { path: file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    /* fail-open — phase recording will surface the missing token */
  }
}

function mintCompanionToken() {
  if (!_companionTokenSnapshot) return false;
  try {
    fs.mkdirSync(path.dirname(_companionTokenSnapshot.path), { recursive: true, mode: 0o700 });
    const data = { ..._companionTokenSnapshot.data, timestamp: Date.now() };
    fs.writeFileSync(_companionTokenSnapshot.path, JSON.stringify(data), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// ─── Memory plugin detection ───────────────────────────────────────────────

/**
 * Detect installed memory plugins (cortex, mem0, or any operator-defined
 * plugin from BRIEF_MEMORY_PLUGINS_JSON). The candidate list comes from
 * `lib/memory-plugin-config.js` so detection rules are configurable via env.
 * Returns `{ name, recallTool, rememberTool, saveTool }` or null.
 * Exported for test coverage.
 */
function detectMemoryPlugin(env = process.env) {
  const home = require('node:os').homedir();
  const candidates = loadMemoryPluginCandidates(env);
  for (const c of candidates) {
    for (const base of c.manifestGlob) {
      const dir = path.join(home, base);
      if (!fs.existsSync(dir)) continue;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      if (entries.some((e) => c.probe.test(e.name))) return c;
    }
  }
  return null;
}

// ─── related-tickets.json reading ──────────────────────────────────────────

function readRelatedManifest(tasksDir) {
  const p = path.join(tasksDir, 'related-tickets.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function listLinkedIds(manifest) {
  if (!manifest) return [];
  const ids = new Set();
  if (manifest.parent && manifest.parent.id) ids.add(manifest.parent.id);
  for (const key of ['siblings', 'blockedBy', 'dependsOn', 'relatedTo']) {
    for (const e of manifest[key] || []) if (e && e.id) ids.add(e.id);
  }
  return [...ids];
}

// ─── Phase state CLI wrappers ──────────────────────────────────────────────

function callPhaseCli(args) {
  mintCompanionToken();
  const r = spawnSync(process.execPath, [BRIEF_PHASE_CLI, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return { code: r.status ?? -1, out: (r.stdout || '') + (r.stderr || '') };
}

function getCurrentPhase(ticket) {
  const r = callPhaseCli(['current', ticket]);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.out.trim().split('\n').pop()).currentPhase;
  } catch {
    return null;
  }
}

function ensureInit(ticket) {
  const r = callPhaseCli(['init', ticket]);
  if (r.code !== 0) die(`Could not init brief-phase state:\n${r.out}`);
}

function recordPhase(ticket, phase, summary) {
  return callPhaseCli(['record', ticket, phase, '--summary', summary || '']);
}

function transitionPhase(ticket, target) {
  return callPhaseCli(['transition', ticket, target]);
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

function main(argv) {
  const startedAt = Date.now();
  const args = argv.slice(2);
  const ticket = args[0];
  if (!ticket || /^-/.test(ticket)) {
    process.stderr.write('usage: brief-next.js <TICKET>\n  e.g. node brief-next.js ECHO-4560\n');
    process.exit(2);
  }
  logNextScriptEvent('brief-next', {
    event: 'invoked',
    ticket,
    cwd: process.cwd(),
    agent: process.env.CLAUDE_CURRENT_AGENT || null,
  });

  snapshotCompanionToken('brief-phase-state.js', ticket);

  const tasksBase = resolveTasksBase();
  const tasksDir = path.join(tasksBase, ticket);
  if (!fs.existsSync(tasksDir)) die(`tasks dir not found: ${tasksDir}`);

  const manifest = readRelatedManifest(tasksDir);
  const linkedIds = listLinkedIds(manifest);
  const memory = detectMemoryPlugin();
  const worktreeRoot = resolveWorktreeRoot() || path.dirname(tasksBase);

  ensureInit(ticket);
  let phase = getCurrentPhase(ticket) || BRIEF_INITIAL_PHASE;

  const ctx = { ticket, tasksDir, tasksBase, manifest, linkedIds, memory, worktreeRoot };

  // Look up the registered handler for the current phase and ask it whether
  // the phase is ready to advance. The phase handler does NOT perform the
  // record/transition itself — that stays here so all state mutations live
  // in one place.
  const handler = getPhase(phase);
  const verdict = handler.validate(ctx);

  let advanced = false;
  let blockReason = '';

  if (verdict.ok && handler.next) {
    const rec = recordPhase(ticket, phase, verdict.summary || '');
    if (rec.code !== 0) {
      blockReason = `Could not record phase ${phase}:\n${rec.out}`;
    } else {
      const t = transitionPhase(ticket, handler.next);
      if (t.code !== 0) {
        blockReason = `Could not transition to ${handler.next}:\n${t.out}`;
      } else {
        advanced = true;
        phase = handler.next;
      }
    }
  } else if (Array.isArray(verdict.errors) && verdict.errors.length > 0) {
    blockReason = verdict.errors.join('\n');
  }
  // Else: not ok but no errors — waiting (e.g. memorize before sentinel).

  // Header + body
  const header = [
    `brief-next: ${ticket}`,
    `  tasks dir: ${tasksDir}`,
    `  current phase (after this run): ${phase}`,
    `  memory plugin: ${memory ? memory.name : '(none detected)'}`,
    `  linked tickets: ${linkedIds.length}${linkedIds.length ? ` (${linkedIds.join(', ')})` : ''}`,
    advanced ? '  result: PHASE ADVANCED' : blockReason ? '  result: BLOCKED' : '  result: WAITING',
    '',
  ].join('\n');

  const instructorPhase = getPhase(phase);
  const instructions = instructorPhase.instructions(ctx);
  const body =
    blockReason && !advanced
      ? [
          `## ❌ Phase ${phase.toUpperCase()} blocked`,
          '',
          '```',
          blockReason,
          '```',
          '',
          '---',
          '',
          instructions,
        ].join('\n')
      : instructions;

  process.stdout.write(header + '\n' + body);

  const { renderNextActionFooter } = require('../lib/next-action-footer');
  process.stdout.write(
    renderNextActionFooter({
      scriptName: 'brief-next.js',
      ticket,
      phase,
      terminalPhase: 'done',
      advanced,
      blockReason,
    })
  );

  const exitCode = blockReason && !advanced ? 2 : 0;
  logNextScriptEvent('brief-next', {
    event: 'completed',
    ticket,
    phase,
    advanced,
    blocked: Boolean(blockReason),
    blockReason: blockReason ? blockReason.slice(0, 500) : null,
    linkedTickets: linkedIds.length,
    memoryPlugin: memory ? memory.name : null,
    exitCode,
    durationMs: Date.now() - startedAt,
  });
  process.exit(exitCode);
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (e) {
    die(e.message || String(e));
  }
}

module.exports = { detectMemoryPlugin };
