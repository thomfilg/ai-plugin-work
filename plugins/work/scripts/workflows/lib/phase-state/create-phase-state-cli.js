'use strict';

/**
 * create-phase-state-cli.js
 *
 * Factory that produces a phase-state CLI handler. Lifted verbatim from
 * `work-tasks/tasks-phase-state.js` (GH-478, Task 6) so the 12 sibling
 * `*-phase-state.js` scripts can collapse to ~20-line wrappers that
 * differ only by their phase registry, allowed-agent list, and
 * state-file name.
 *
 * Factory contract:
 *
 *   createPhaseStateCli({
 *     phaseRegistry: {
 *       PHASE_ORDER:   string[],
 *       INITIAL_PHASE: string,
 *       TERMINAL_PHASE?: string,
 *       nextPhases(current): string[],
 *       canTransition(current, next): boolean,
 *       isPhase(name): boolean,
 *     },
 *     allowedAgents: string[],
 *     stateFileName: string,
 *     scriptFilename: string, // pass `__filename` from the wrapper
 *   }) => { main(argv), PHASES, run }
 *
 * State-file shape (frozen — must match the un-refactored baseline):
 *
 *   { ticket, createdAt, updatedAt, currentPhase, phases }
 */

const fs = require('node:fs');
const path = require('node:path');

const { consumeToken } = require('../scripts/write-report');
const { normalizeAgentName } = require('../agent-detection');
const { resolveTasksBaseWithFallback } = require('../ticket-validation');

let configMod;
try {
  configMod = require('../config');
} catch (e) {
  if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
  configMod = null;
}

const TOKEN_MAX_AGE_MS = 10_000;
const GATED_SUBCOMMANDS = ['init', 'record', 'transition'];

function errorExit(message) {
  process.stderr.write(`${JSON.stringify({ error: true, message })}\n`);
  process.exit(1);
}

function successOut(data) {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

function sanitizeId(ticketId) {
  if (configMod && typeof configMod.safeTicketId === 'function') {
    try {
      return configMod.safeTicketId(ticketId);
    } catch (e) {
      if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
    }
  }
  return ticketId;
}

function getStatePath(stateFileName, ticketId) {
  if (!ticketId || /\.\.|[\\:\x00]/.test(ticketId)) {
    throw new Error(`Invalid ticket ID: ${ticketId}`);
  }
  const base = path.resolve(resolveTasksBaseWithFallback());
  const safeId = sanitizeId(ticketId);
  const resolved = path.resolve(base, safeId, stateFileName);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error(`Invalid ticket ID: ${ticketId}`);
  }
  return resolved;
}

function readState(stateFileName, ticketId) {
  const p = getStatePath(stateFileName, ticketId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeState(stateFileName, ticketId, state) {
  const p = getStatePath(stateFileName, ticketId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  try {
    fs.unlinkSync(p);
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
  }
  fs.renameSync(tmp, p);
}

function verifyToken(scriptName, allowedAgents, expectedTicketId) {
  // Pass ticket id so consumeToken hits the per-ticket keyed path
  // (/tmp/.claude-write-tokens/<script-basename>.<TICKET>). The PreToolUse
  // hook mints ONLY the keyed path post-suffix-strip — checking the legacy
  // unkeyed path here would fail every time for any agent in a worktree
  // session. (Ported from brief-phase-state.js pre-factory comment.)
  const token = consumeToken(scriptName, expectedTicketId);
  if (!token) {
    errorExit("No valid write token found. This script can only be called through Claude Code's agent system.");
  }
  if (typeof token.timestamp !== 'number' || !Number.isFinite(token.timestamp)) {
    errorExit('Token has invalid or missing timestamp.');
  }
  if (typeof token.agent !== 'string' || !token.agent) {
    errorExit('Token has invalid or missing agent field.');
  }
  const age = Date.now() - token.timestamp;
  if (age < 0) errorExit(`Write token timestamp is in the future (${Math.abs(age)}ms ahead).`);
  if (age > TOKEN_MAX_AGE_MS) {
    errorExit(`Write token expired (${age}ms old, max ${TOKEN_MAX_AGE_MS}ms).`);
  }
  const agentNormalized = normalizeAgentName(token.agent);
  if (!allowedAgents.includes(agentNormalized)) {
    errorExit(`Agent "${token.agent}" is not authorized. Allowed agents: ${allowedAgents.join(', ')}.`);
  }
  return token;
}

function parseFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return null;
  return args[i + 1];
}

function cmdInit(stateFileName, initialPhase, ticket) {
  const existing = readState(stateFileName, ticket);
  if (existing) {
    successOut({ ok: true, status: 'exists', state: existing });
    return;
  }
  const now = new Date().toISOString();
  const state = { ticket, createdAt: now, updatedAt: now, currentPhase: initialPhase, phases: {} };
  writeState(stateFileName, ticket, state);
  successOut({ ok: true, status: 'created', state });
}

function cmdCurrent(stateFileName, ticket) {
  const state = readState(stateFileName, ticket);
  if (!state) {
    successOut({ ok: true, currentPhase: null, state: null });
    return;
  }
  successOut({ ok: true, currentPhase: state.currentPhase, state });
}

function cmdRecord(stateFileName, phaseOrder, isPhase, ticket, phase, args) {
  if (!isPhase(phase)) errorExit(`Unknown phase "${phase}". Valid: ${phaseOrder.join(', ')}.`);
  const state = readState(stateFileName, ticket);
  if (!state) errorExit(`No phase state for ${ticket}. Run \`init\` first.`);
  const summary = parseFlag(args, '--summary') || '';
  const now = new Date().toISOString();
  state.phases[phase] = { completedAt: now, summary };
  state.updatedAt = now;
  writeState(stateFileName, ticket, state);
  successOut({ ok: true, recordedPhase: phase, state });
}

function cmdTransition(stateFileName, phaseOrder, isPhase, canTransition, nextPhases, ticket, target) {
  if (!isPhase(target)) errorExit(`Unknown target phase "${target}". Valid: ${phaseOrder.join(', ')}.`);
  const state = readState(stateFileName, ticket);
  if (!state) errorExit(`No phase state for ${ticket}. Run \`init\` first.`);
  if (!canTransition(state.currentPhase, target)) {
    const allowed = nextPhases(state.currentPhase);
    errorExit(
      `Invalid transition ${state.currentPhase} → ${target}. Allowed from ${state.currentPhase}: ${
        allowed.length ? allowed.join(', ') : '(terminal)'
      }.`
    );
  }
  if (!state.phases[state.currentPhase]) {
    errorExit(
      `Cannot transition: phase "${state.currentPhase}" has no recorded evidence. Run \`record ${ticket} ${state.currentPhase}\` first.`
    );
  }
  const now = new Date().toISOString();
  state.currentPhase = target;
  state.updatedAt = now;
  writeState(stateFileName, ticket, state);
  successOut({ ok: true, currentPhase: target, state });
}

function dispatchSubcommand(opts, sub, args) {
  const { phaseRegistry, stateFileName } = opts;
  const { PHASE_ORDER, INITIAL_PHASE, nextPhases, canTransition, isPhase } = phaseRegistry;
  const ticket = args[1];
  if (sub === 'init') return cmdInit(stateFileName, INITIAL_PHASE, ticket);
  if (sub === 'current') return cmdCurrent(stateFileName, ticket);
  if (sub === 'record') {
    const phase = args[2];
    if (!phase) errorExit(`Usage: ${opts.scriptName} record <TICKET> <phase> [--summary "..."]`);
    return cmdRecord(stateFileName, PHASE_ORDER, isPhase, ticket, phase, args.slice(3));
  }
  if (sub === 'transition') {
    const target = args[2];
    if (!target) errorExit(`Usage: ${opts.scriptName} transition <TICKET> <target>`);
    return cmdTransition(stateFileName, PHASE_ORDER, isPhase, canTransition, nextPhases, ticket, target);
  }
  errorExit(`Unknown subcommand: ${sub}`);
}

function runCli(opts, argv) {
  try {
    const args = argv.slice(2);
    const sub = args[0];
    if (!sub) errorExit(`Usage: ${opts.scriptName} <init|current|record|transition> <TICKET> [args]`);
    const ticket = args[1];
    if (!ticket) errorExit('Missing ticket ID.');
    if (GATED_SUBCOMMANDS.includes(sub)) verifyToken(opts.scriptName, opts.allowedAgents, ticket);
    return dispatchSubcommand(opts, sub, args);
  } catch (e) {
    errorExit(e.message);
  }
}

function createPhaseStateCli(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new Error('createPhaseStateCli: options object required');
  }
  const { phaseRegistry, allowedAgents, stateFileName, scriptFilename } = opts;
  if (!phaseRegistry) throw new Error('createPhaseStateCli: phaseRegistry required');
  if (!Array.isArray(allowedAgents) || allowedAgents.length === 0) {
    throw new Error('createPhaseStateCli: allowedAgents must be a non-empty array');
  }
  if (!stateFileName || typeof stateFileName !== 'string') {
    throw new Error('createPhaseStateCli: stateFileName required');
  }
  // Derive the script identity from the wrapper's __filename rather than a
  // hand-typed string. This eliminates the typo foot-gun where a wrapper
  // could mis-type its own filename (e.g. underscore vs dash) and silently
  // look up tokens under the wrong key.
  if (!scriptFilename || typeof scriptFilename !== 'string') {
    throw new Error('createPhaseStateCli: scriptFilename (pass __filename) required');
  }
  const resolvedOpts = { ...opts, scriptName: path.basename(scriptFilename) };
  const main = (argv) => runCli(resolvedOpts, argv);
  return { main, run: main, PHASES: phaseRegistry.PHASE_ORDER };
}

module.exports = { createPhaseStateCli, TOKEN_MAX_AGE_MS };
