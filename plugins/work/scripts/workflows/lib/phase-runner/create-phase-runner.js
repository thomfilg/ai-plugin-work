'use strict';

/**
 * create-phase-runner.js
 *
 * Factory that produces a self-paced `main(argv)` runner for `*-next.js`
 * workflows (brief, spec, ci, tasks, task-review, reports, pr-review,
 * completion, cleanup, qa, pr, code). Lifted from `brief-next.js`'s `main()`
 * orchestrator so each per-workflow runner can collapse to a thin wrapper.
 *
 * Contract:
 *   const main = createPhaseRunner({
 *     scriptName,         // e.g. 'brief-next.js' (used in messages + footer)
 *     phaseStateCliPath,  // absolute path to <foo>-phase-state.js
 *     initialPhase,       // e.g. BRIEF_INITIAL_PHASE
 *     getPhase,           // (name) => { next, validate(ctx), instructions(ctx) }
 *     usageHint,          // string printed to stderr on missing/invalid argv
 *   });
 *   main(process.argv);
 *
 * Exit codes: 0 = advanced or waiting, 2 = blocked or die().
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolveTasksBaseWithFallback, resolveWorktreeRoot } = require('../ticket-validation');

let logNextScriptEvent;
try {
  ({ logNextScriptEvent } = require('../next-script-log'));
} catch {
  logNextScriptEvent = () => {};
}

function die(scriptName, msg) {
  process.stderr.write(`${scriptName}: ${msg}\n`);
  process.exit(2);
}

function snapshotCompanionToken(stateCliBasename, ticketId) {
  try {
    const dir = process.env.CLAUDE_WRITE_TOKEN_DIR || '/tmp/.claude-write-tokens';
    const bareTicket = ticketId ? String(ticketId).split('/')[0] : null;
    const keyed = bareTicket ? path.join(dir, `${stateCliBasename}.${bareTicket}`) : null;
    const legacy = path.join(dir, stateCliBasename);
    const file = keyed && fs.existsSync(keyed) ? keyed : fs.existsSync(legacy) ? legacy : null;
    if (!file) return null;
    return { path: file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return null;
  }
}

function mintCompanionToken(snap) {
  if (!snap) return false;
  try {
    fs.mkdirSync(path.dirname(snap.path), { recursive: true, mode: 0o700 });
    const data = { ...snap.data, timestamp: Date.now() };
    fs.writeFileSync(snap.path, JSON.stringify(data), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function detectMemoryPlugin(env = process.env) {
  try {
    const { loadMemoryPluginCandidates } = require('../../work-brief/lib/memory-plugin-config');
    const home = require('node:os').homedir();
    const candidates = loadMemoryPluginCandidates(env);
    for (const c of candidates) {
      for (const base of c.manifestGlob) {
        const dir = path.join(home, base);
        if (!fs.existsSync(dir)) continue;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        if (entries.some((e) => c.probe.test(e.name))) return c;
      }
    }
  } catch {
    /* memory plugin module is brief-specific; absence is fine */
  }
  return null;
}

function readRelatedManifest(tasksDir) {
  const p = path.join(tasksDir, 'related-tickets.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
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

function callPhaseCli(phaseStateCliPath, tokenSnap, args) {
  mintCompanionToken(tokenSnap);
  const r = spawnSync(process.execPath, [phaseStateCliPath, ...args], { encoding: 'utf8', stdio: 'pipe' });
  return { code: r.status ?? -1, out: (r.stdout || '') + (r.stderr || '') };
}

function getCurrentPhase(phaseStateCliPath, tokenSnap, ticket) {
  const r = callPhaseCli(phaseStateCliPath, tokenSnap, ['current', ticket]);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.out.trim().split('\n').pop()).currentPhase; } catch { return null; }
}

function advancePhase(phaseStateCliPath, tokenSnap, ticket, phase, verdict, handler) {
  if (verdict.ok && handler.next) {
    const rec = callPhaseCli(phaseStateCliPath, tokenSnap, ['record', ticket, phase, '--summary', verdict.summary || '']);
    if (rec.code !== 0) {
      return { advanced: false, phase, blockReason: `Could not record phase ${phase}:\n${rec.out}` };
    }
    const t = callPhaseCli(phaseStateCliPath, tokenSnap, ['transition', ticket, handler.next]);
    if (t.code !== 0) {
      return { advanced: false, phase, blockReason: `Could not transition to ${handler.next}:\n${t.out}` };
    }
    return { advanced: true, phase: handler.next, blockReason: '' };
  }
  if (Array.isArray(verdict.errors) && verdict.errors.length > 0) {
    return { advanced: false, phase, blockReason: verdict.errors.join('\n') };
  }
  return { advanced: false, phase, blockReason: '' };
}

function resultLineFor(advanced, blockReason) {
  if (advanced) return '  result: PHASE ADVANCED';
  return blockReason ? '  result: BLOCKED' : '  result: WAITING';
}

function buildHeader(scriptName, ticket, ctx, phase, memory, linkedIds, advanced, blockReason) {
  return [
    `${scriptName.replace(/\.js$/, '')}: ${ticket}`,
    `  tasks dir: ${ctx.tasksDir}`,
    `  current phase (after this run): ${phase}`,
    `  memory plugin: ${memory ? memory.name : '(none detected)'}`,
    `  linked tickets: ${linkedIds.length}${linkedIds.length ? ` (${linkedIds.join(', ')})` : ''}`,
    resultLineFor(advanced, blockReason),
    '',
  ].join('\n');
}

function buildBody(getPhase, phase, ctx, advanced, blockReason) {
  const instructions = getPhase(phase).instructions(ctx);
  if (blockReason && !advanced) {
    return [`## ❌ Phase ${phase.toUpperCase()} blocked`, '', '```', blockReason, '```', '', '---', '', instructions].join('\n');
  }
  return instructions;
}

function writeFooter(scriptName, ticket, phase, advanced, blockReason) {
  try {
    const { renderNextActionFooter } = require('../next-action-footer');
    process.stdout.write(
      renderNextActionFooter({ scriptName, ticket, phase, terminalPhase: 'done', advanced, blockReason })
    );
  } catch {
    /* footer is optional */
  }
}

function renderAndExit(opts, { ticket, phase, ctx, advanced, blockReason, memory, linkedIds, startedAt }) {
  const { scriptName, getPhase } = opts;
  process.stdout.write(buildHeader(scriptName, ticket, ctx, phase, memory, linkedIds, advanced, blockReason) + '\n');
  process.stdout.write(buildBody(getPhase, phase, ctx, advanced, blockReason));
  writeFooter(scriptName, ticket, phase, advanced, blockReason);
  const exitCode = blockReason && !advanced ? 2 : 0;
  logNextScriptEvent(scriptName.replace(/\.js$/, ''), {
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

function executePhase(opts, ticket, startedAt) {
  const { scriptName, phaseStateCliPath, initialPhase, getPhase } = opts;
  logNextScriptEvent(scriptName.replace(/\.js$/, ''), {
    event: 'invoked',
    ticket,
    cwd: process.cwd(),
    agent: process.env.CLAUDE_CURRENT_AGENT || null,
  });
  const tokenSnap = snapshotCompanionToken(path.basename(phaseStateCliPath), ticket);
  const tasksBase = resolveTasksBaseWithFallback();
  const tasksDir = path.join(tasksBase, ticket);
  if (!fs.existsSync(tasksDir)) die(scriptName, `tasks dir not found: ${tasksDir}`);
  const manifest = readRelatedManifest(tasksDir);
  const linkedIds = listLinkedIds(manifest);
  const memory = detectMemoryPlugin();
  const worktreeRoot = resolveWorktreeRoot() || path.dirname(tasksBase);
  const initRes = callPhaseCli(phaseStateCliPath, tokenSnap, ['init', ticket]);
  if (initRes.code !== 0) die(scriptName, `Could not init phase state:\n${initRes.out}`);
  const startPhase = getCurrentPhase(phaseStateCliPath, tokenSnap, ticket) || initialPhase;
  const ctx = { ticket, tasksDir, tasksBase, manifest, linkedIds, memory, worktreeRoot };
  const handler = getPhase(startPhase);
  const verdict = handler.validate(ctx);
  const { advanced, phase, blockReason } = advancePhase(phaseStateCliPath, tokenSnap, ticket, startPhase, verdict, handler);
  renderAndExit(opts, { ticket, phase, ctx, advanced, blockReason, memory, linkedIds, startedAt });
}

function runPhase(opts, argv) {
  const { scriptName, usageHint } = opts;
  const startedAt = Date.now();
  const ticket = argv.slice(2)[0];
  if (!ticket || /^-/.test(ticket)) {
    process.stderr.write(`${usageHint || `usage: ${scriptName} <TICKET>`}\n`);
    process.exit(2);
  }
  try {
    executePhase(opts, ticket, startedAt);
  } catch (err) {
    die(scriptName, err && err.message ? err.message : String(err));
  }
}

/**
 * @param {object} opts
 * @param {string} opts.scriptName
 * @param {string} opts.phaseStateCliPath
 * @param {string} opts.initialPhase
 * @param {(name: string) => { next: string|null, validate: Function, instructions: Function }} opts.getPhase
 * @param {string} opts.usageHint
 * @returns {(argv: string[]) => void}
 */
function createPhaseRunner(opts) {
  const { scriptName, phaseStateCliPath, initialPhase, getPhase } = opts;
  if (!scriptName || !phaseStateCliPath || !initialPhase || typeof getPhase !== 'function') {
    throw new Error('createPhaseRunner: missing required option(s)');
  }
  return (argv) => runPhase(opts, argv);
}

module.exports = { createPhaseRunner };
