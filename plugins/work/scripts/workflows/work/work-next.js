#!/usr/bin/env node

/**
 * work-next.js — Script-driven orchestrator for /work.
 *
 * Outputs a SINGLE instruction — the next thing the AI should do.
 * A PostToolUse hook (work-auto-advance.js) calls this after each step
 * delegation completes, creating an automatic advance loop.
 *
 * Architecture:
 *   work-next.js          — DI wiring + CLI entry
 *   lib/orchestrator-context.js — shared engine wrappers (with work.workflow.js)
 *   lib/next-instruction.js     — core orchestration loop
 *   lib/next-preflight.js       — validation, persistence, short-circuits
 *   lib/session-conflict.js     — active-session conflict detection
 *   lib/instruction-builder.js  — delegation type mapping
 *   lib/state-context.js        — progress derivation from work state
 *   lib/marker.js               — session marker file management
 *   lib/step-enrichments/       — registry of per-step prompt overrides
 *
 * Usage: node work-next.js <TICKET_ID> [--rework] [--init]
 */

const path = require('path');

// Error handlers — log errors as blocked instructions instead of swallowing silently
if (require.main === module) {
  const { installInstructionGuards } = require(
    path.join(__dirname, '..', 'lib', 'instruction-guards')
  );
  installInstructionGuards('work_instruction');
}

// ─── Load shared modules from /work ─────────────────────────────────────────
const { resolvePluginPaths } = require(path.join(__dirname, 'lib', 'resolve-plugin-root'));
const { workDir, libDir } = resolvePluginPaths(__dirname);

function tryRequire(modulePath, fallback) {
  try {
    return require(modulePath);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return fallback;
    throw err;
  }
}

const { appendAction } = tryRequire(path.join(workDir, 'lib', 'work-actions'), {
  appendAction: () => {},
});
const tp = tryRequire(path.join(libDir, 'ticket-provider'), null);
if (!tp) process.exit(0);

// ─── Configuration ──────────────────────────────────────────────────────────
const getConfig = require(path.join(libDir, 'get-config'));
const WORKTREES_BASE = getConfig('WORKTREES_BASE') || '';
const TASKS_BASE =
  getConfig('TASKS_BASE') || (WORKTREES_BASE ? path.join(WORKTREES_BASE, 'tasks') : '');
const MAIN_WORKTREE_FOLDER = process.env.REPO_NAME || 'my-project';

if (!WORKTREES_BASE || !TASKS_BASE) {
  console.log(
    JSON.stringify({
      type: 'work_instruction',
      action: 'blocked',
      state: {
        ticket: null,
        currentStep: null,
        progress: '0/0',
        completedSteps: [],
        remainingSteps: [],
      },
      reason: 'WORKTREES_BASE or TASKS_BASE not configured',
      suggestion: 'Set WORKTREES_BASE and TASKS_BASE in your .envrc or environment',
    })
  );
  process.exit(0);
}

// ─── Shared modules from /work ──────────────────────────────────────────────
const { validateRawTicketInput } = require(path.join(libDir, 'ticket-provider'));
const { createOrchestratorContext } = require(path.join(workDir, 'lib', 'orchestrator-context'));
const { createGetNextInstruction } = require(path.join(workDir, 'lib', 'next-instruction'));
const { detectSessionConflict } = require(path.join(workDir, 'lib', 'session-conflict'));

// ─── Local modules ──────────────────────────────────────────────────────────
const { buildInstruction } = require(path.join(__dirname, 'lib', 'instruction-builder'));
const { buildStateContext } = require(path.join(__dirname, 'lib', 'state-context'));
const { writeMarkerFile } = require(path.join(__dirname, 'lib', 'marker'));

// ─── Constants ──────────────────────────────────────────────────────────────
const { buildVerdictRegex } = require(path.join(__dirname, '..', 'lib', 'parse-completion-status'));
// `type` enables the parse-report-status fallback in engine/inspect.js for
// real-world prose verdicts (e.g. "Overall Assessment: ✅ Well-Implemented").
const REQUIRED_REPORTS = [
  { file: 'tests.check.md', passPattern: buildVerdictRegex(['APPROVED']), type: 'tests' },
  {
    file: 'code-review.check.md',
    passPattern: buildVerdictRegex(['APPROVED']),
    type: 'codeReview',
  },
  {
    file: 'completion.check.md',
    passPattern: buildVerdictRegex(['COMPLETE', 'APPROVED']),
    type: 'completion',
  },
];

// ─── DI wiring ──────────────────────────────────────────────────────────────
const ctx = createOrchestratorContext({
  workDir,
  tp,
  appendAction,
  TASKS_BASE,
  WORKTREES_BASE,
  MAIN_WORKTREE_FOLDER,
  REQUIRED_REPORTS,
});

const getNextInstruction = createGetNextInstruction({
  ...ctx,
  tp,
  appendAction,
  validateRawTicketInput,
  TASKS_BASE,
  WORKTREES_BASE,
  MAIN_WORKTREE_FOLDER,
  workDir,
  work2Dir: __dirname,
});

// ─── CLI ────────────────────────────────────────────────────────────────────

function exitBlockedPretty(reason, suggestion) {
  console.log(
    JSON.stringify({ type: 'work_instruction', action: 'blocked', reason, suggestion }, null, 2)
  );
  process.exit(1);
}

function parseCliTicket(args) {
  const rework = args.includes('--rework');
  const init = args.includes('--init');
  // Take only the FIRST positional arg as the ticket. Multiple positionals
  // (e.g. "ECHO-4446 TASKS ECHO-4446") are an error — they would otherwise be
  // silently joined into "ECHO-4446 TASKS ECHO-4446" and create a bogus folder.
  const positionals = args.filter((a) => !a.startsWith('--'));
  const ticketRaw = (positionals[0] || '').trim();
  if (positionals.length > 1) {
    exitBlockedPretty(
      `Multiple positional arguments received: ${JSON.stringify(positionals)}. Pass exactly ONE ticket ID.`,
      'Quote suffixes: use APP-1234-foo (one arg), not APP-1234 foo (two args).'
    );
  }
  return { ticketRaw, rework, init };
}

function validateCliTicket(ticketRaw) {
  // Validate BEFORE writeMarkerFile (which creates a tasks/<id>/ folder).
  // We re-validate inside getNextInstruction too, but the marker write happens
  // first under --init, so we must gate it here as well.
  let validated;
  try {
    const earlyProviderConfig = tp.getProviderConfig({ skipPrompt: true });
    validated = validateRawTicketInput(ticketRaw, earlyProviderConfig);
  } catch (err) {
    exitBlockedPretty(
      err.message,
      'Pass a canonical ticket ID like PROJ-123 (or PROJ-123-suffix). No spaces or path separators.'
    );
  }
  // Active-session conflict check: once a session is bootstrapped, future
  // invocations MUST use the same canonical ID. Pass `APP-1234` when an active
  // session uses `APP-1234-foo` (or vice versa) → block.
  const conflict = detectSessionConflict(validated, TASKS_BASE, tp);
  if (conflict) {
    exitBlockedPretty(conflict.reason, `Re-invoke with: ${conflict.canonical}`);
  }
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(
      JSON.stringify({
        type: 'work_instruction',
        action: 'blocked',
        state: {
          ticket: null,
          currentStep: null,
          progress: '0/0',
          completedSteps: [],
          remainingSteps: [],
        },
        reason: 'No ticket ID provided',
        suggestion: 'Usage: node work-next.js <TICKET_ID> [--rework]',
      })
    );
    process.exit(0);
  }

  const { ticketRaw, rework, init } = parseCliTicket(args);
  validateCliTicket(ticketRaw);

  // On --init, write marker file for auto-advance hook detection (stamped with
  // the owning session id + worktree root so hooks scope to this terminal).
  if (init) {
    writeMarkerFile(ticketRaw, { TASKS_BASE, tp });
  }

  const instruction = getNextInstruction(ticketRaw, rework);
  // Single-line JSON keeps stdout parseable by `JSON.parse(stdout.trim())`
  // and `stdout.slice(lastIndexOf('{'))` patterns used across tests; pretty-
  // printing introduces nested newlines that break the latter on multi-key
  // payloads (e.g. the terminal short-circuit's `state` block).
  console.log(JSON.stringify(instruction));
}

if (require.main === module) main();

module.exports = { getNextInstruction, buildStateContext, buildInstruction };
