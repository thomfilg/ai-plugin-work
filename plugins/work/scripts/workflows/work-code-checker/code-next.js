#!/usr/bin/env node

/**
 * code-next.js
 *
 * Self-paced runner for the `check` step's code-checker agent.
 * Mirrors completion-next.js / spec-next.js. Phases:
 *   inputs → change_classify → file_coverage → standards_audit →
 *   kind_checks → report → memorize → done
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CODE_PHASE_CLI = path.resolve(__dirname, 'code-phase-state.js');

const { CODE_INITIAL_PHASE } = require('./code-phase-registry');
const { getPhase } = require('./lib/phase-registry');
const { loadMemoryPluginCandidates } = require('./lib/memory-plugin-config');

let logNextScriptEvent;
try {
  ({ logNextScriptEvent } = require('../lib/next-script-log'));
} catch {
  logNextScriptEvent = () => {};
}

const { resolveTasksBaseWithFallback, resolveWorktreeRoot } = require('../lib/ticket-validation');

let config;
try {
  config = require('../lib/config');
} catch {
  config = null;
}

function die(msg) {
  process.stderr.write(`code-next: ${msg}\n`);
  process.exit(2);
}

let _companionTokenSnapshot = null;

function snapshotCompanionToken(scriptBasename, ticketId) {
  try {
    const dir = process.env.CLAUDE_WRITE_TOKEN_DIR || '/tmp/.claude-write-tokens';
    const bareTicket = ticketId ? String(ticketId).split('/')[0] : null;
    const keyed = bareTicket ? path.join(dir, `${scriptBasename}.${bareTicket}`) : null;
    const legacy = path.join(dir, scriptBasename);
    const file = keyed && fs.existsSync(keyed) ? keyed : fs.existsSync(legacy) ? legacy : null;
    if (!file) return;
    _companionTokenSnapshot = { path: file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    /* fail-open */
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

function callPhaseCli(args) {
  mintCompanionToken();
  const r = spawnSync(process.execPath, [CODE_PHASE_CLI, ...args], {
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
  if (r.code !== 0) die(`Could not init code-phase state:\n${r.out}`);
}

function recordPhase(ticket, phase, summary) {
  return callPhaseCli(['record', ticket, phase, '--summary', summary || '']);
}

function transitionPhase(ticket, target) {
  return callPhaseCli(['transition', ticket, target]);
}

function main(argv) {
  const startedAt = Date.now();
  const args = argv.slice(2);
  const ticket = args[0];
  if (!ticket || /^-/.test(ticket)) {
    process.stderr.write('usage: code-next.js <TICKET>\n  e.g. node code-next.js ECHO-4579\n');
    process.exit(2);
  }
  logNextScriptEvent('code-next', {
    event: 'invoked',
    ticket,
    cwd: process.cwd(),
    agent: process.env.CLAUDE_CURRENT_AGENT || null,
  });

  snapshotCompanionToken('code-phase-state.js', ticket);

  const tasksBase = resolveTasksBaseWithFallback();
  const tasksDir = path.join(tasksBase, ticket);
  if (!fs.existsSync(tasksDir)) die(`tasks dir not found: ${tasksDir}`);

  const manifest = readRelatedManifest(tasksDir);
  const linkedIds = listLinkedIds(manifest);
  const memory = detectMemoryPlugin();
  const worktreeRoot = resolveWorktreeRoot() || path.dirname(tasksBase);

  ensureInit(ticket);
  let phase = getCurrentPhase(ticket) || CODE_INITIAL_PHASE;

  const ctx = { ticket, tasksDir, tasksBase, manifest, linkedIds, memory, worktreeRoot };

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

  const header = [
    `code-next: ${ticket}`,
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

  process.stdout.write(`${header}\n${body}`);

  const { renderNextActionFooter } = require('../lib/next-action-footer');
  process.stdout.write(
    renderNextActionFooter({
      scriptName: 'code-next.js',
      ticket,
      phase,
      terminalPhase: 'done',
      advanced,
      blockReason,
    })
  );

  const exitCode = blockReason && !advanced ? 2 : 0;
  logNextScriptEvent('code-next', {
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
