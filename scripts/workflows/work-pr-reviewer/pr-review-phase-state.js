#!/usr/bin/env node

/**
 * pr-review-phase-state.js
 *
 * Authorized writer for `tasks/<ticket>/pr-review-phase.json`. Mirrors
 * code-phase-state.js. Only callable through Claude Code's agent system
 * (token-protected), and only by the pr-reviewer agent.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { consumeToken } = require('../lib/scripts/write-report');
const { normalizeAgentName } = require('../lib/agent-detection');
const {
  PR_REVIEW_PHASE_ORDER,
  PR_REVIEW_INITIAL_PHASE,
  prReviewNextPhases,
  prReviewCanTransition,
  isPrReviewPhase,
} = require('./pr-review-phase-registry');

let config;
try {
  config = require('../lib/config');
} catch (e) {
  if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
  config = null;
}

const ALLOWED_AGENTS = ['pr-reviewer'];
const GATED_SUBCOMMANDS = ['init', 'record', 'transition'];
const TOKEN_MAX_AGE_MS = 10_000;

const PHASES = PR_REVIEW_PHASE_ORDER;

function errorExit(message) {
  process.stderr.write(`${JSON.stringify({ error: true, message })}\n`);
  process.exit(1);
}

function successOut(data) {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

function sanitizeId(ticketId) {
  try {
    return require('../lib/config').safeTicketId(ticketId);
  } catch (e) {
    if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
    return ticketId;
  }
}

function resolveTasksBase() {
  return (
    process.env.TASKS_BASE ||
    (config && config.TASKS_BASE) ||
    path.join(require('node:os').homedir(), 'worktrees', 'tasks')
  );
}

function getStatePath(ticketId) {
  if (!ticketId || /\.\.|[\\:\x00]/.test(ticketId)) {
    throw new Error(`Invalid ticket ID: ${ticketId}`);
  }
  const base = path.resolve(resolveTasksBase());
  const safeId = sanitizeId(ticketId);
  const resolved = path.resolve(base, safeId, 'pr-review-phase.json');
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error(`Invalid ticket ID: ${ticketId}`);
  }
  return resolved;
}

function readState(ticketId) {
  const p = getStatePath(ticketId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeState(ticketId, state) {
  const p = getStatePath(ticketId);
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

function verifyToken(expectedTicketId) {
  const scriptBasename = path.basename(__filename);
  const token = consumeToken(scriptBasename, expectedTicketId);
  if (!token) {
    errorExit(
      "No valid write token found. This script can only be called through Claude Code's agent system."
    );
  }
  if (typeof token.timestamp !== 'number' || !Number.isFinite(token.timestamp)) {
    errorExit('Token has invalid or missing timestamp.');
  }
  if (typeof token.agent !== 'string' || !token.agent) {
    errorExit('Token has invalid or missing agent field.');
  }
  const age = Date.now() - token.timestamp;
  if (age < 0) errorExit(`Write token timestamp is in the future (${Math.abs(age)}ms ahead).`);
  if (age > TOKEN_MAX_AGE_MS)
    errorExit(`Write token expired (${age}ms old, max ${TOKEN_MAX_AGE_MS}ms).`);
  const agentNormalized = normalizeAgentName(token.agent);
  if (!ALLOWED_AGENTS.includes(agentNormalized)) {
    errorExit(
      `Agent "${token.agent}" is not authorized. Allowed agents: ${ALLOWED_AGENTS.join(', ')}.`
    );
  }
  return token;
}

function parseFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return null;
  return args[i + 1];
}

function cmdInit(ticket) {
  const existing = readState(ticket);
  if (existing) {
    successOut({ ok: true, status: 'exists', state: existing });
    return;
  }
  const now = new Date().toISOString();
  const state = {
    ticket,
    createdAt: now,
    updatedAt: now,
    currentPhase: PR_REVIEW_INITIAL_PHASE,
    phases: {},
  };
  writeState(ticket, state);
  successOut({ ok: true, status: 'created', state });
}

function cmdCurrent(ticket) {
  const state = readState(ticket);
  if (!state) {
    successOut({ ok: true, currentPhase: null, state: null });
    return;
  }
  successOut({ ok: true, currentPhase: state.currentPhase, state });
}

function cmdRecord(ticket, phase, args) {
  if (!isPrReviewPhase(phase)) {
    errorExit(`Unknown phase "${phase}". Valid: ${PR_REVIEW_PHASE_ORDER.join(', ')}.`);
  }
  const state = readState(ticket);
  if (!state) errorExit(`No pr-review-phase state for ${ticket}. Run \`init\` first.`);
  const summary = parseFlag(args, '--summary') || '';
  const now = new Date().toISOString();
  state.phases[phase] = { completedAt: now, summary };
  state.updatedAt = now;
  writeState(ticket, state);
  successOut({ ok: true, recordedPhase: phase, state });
}

function cmdTransition(ticket, target) {
  if (!isPrReviewPhase(target)) {
    errorExit(`Unknown target phase "${target}". Valid: ${PR_REVIEW_PHASE_ORDER.join(', ')}.`);
  }
  const state = readState(ticket);
  if (!state) errorExit(`No pr-review-phase state for ${ticket}. Run \`init\` first.`);
  if (!prReviewCanTransition(state.currentPhase, target)) {
    const allowed = prReviewNextPhases(state.currentPhase);
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
  writeState(ticket, state);
  successOut({ ok: true, currentPhase: target, state });
}

function main(argv) {
  const args = argv.slice(2);
  const sub = args[0];
  if (!sub) {
    errorExit('Usage: pr-review-phase-state.js <init|current|record|transition> <TICKET> [args]');
  }
  const ticket = args[1];
  if (!ticket) errorExit('Missing ticket ID.');

  if (GATED_SUBCOMMANDS.includes(sub)) verifyToken(ticket);

  if (sub === 'init') return cmdInit(ticket);
  if (sub === 'current') return cmdCurrent(ticket);
  if (sub === 'record') {
    const phase = args[2];
    if (!phase)
      errorExit('Usage: pr-review-phase-state.js record <TICKET> <phase> [--summary "..."]');
    return cmdRecord(ticket, phase, args.slice(3));
  }
  if (sub === 'transition') {
    const target = args[2];
    if (!target) errorExit('Usage: pr-review-phase-state.js transition <TICKET> <target>');
    return cmdTransition(ticket, target);
  }
  errorExit(`Unknown subcommand: ${sub}`);
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (e) {
    errorExit(e.message);
  }
}

module.exports = { PHASES, prReviewCanTransition, prReviewNextPhases };
