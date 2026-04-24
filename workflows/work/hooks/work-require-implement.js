#!/usr/bin/env node

/**
 * PreToolUse hook to enforce /work-implement usage during /work command.
 *
 * GH-219 Task 13: Rewritten to use state-based detection via
 * `loadEnforcementContext` + `runPreflight` instead of transcript-based
 * `isWorkCommandActive` / `hasWorkImplementBeenInvoked`.
 *
 * When /work is active (state: in_progress) and the implement step has been
 * reached but /work-implement has not been invoked, blocks direct
 * Write/Edit operations.
 *
 * Also provides hard protection for /work-implement assets themselves,
 * preventing escape-hatch edits via allowed patterns.
 */

const fs = require('fs');
const path = require('path');
const { logHookError } = require(path.join(__dirname, '..', '..', 'lib', 'hook-error-log'));

let didBlock = false;
process.on('uncaughtException', (err) => {
  logHookError(__filename, err);
  process.exit(didBlock ? 2 : 0);
});
process.on('unhandledRejection', (err) => {
  logHookError(__filename, err);
  process.exit(didBlock ? 2 : 0);
});

let config;
try {
  config = require('../../lib/config');
} catch (err) {
  if (
    err &&
    err.code === 'MODULE_NOT_FOUND' &&
    /['"]\.\.\/\.\.\/lib\/config['"]/.test(err.message)
  ) {
    config = null;
  } else {
    throw err;
  }
}
if (!config) process.exit(0);

// ─── Imports: adapter, preflight, audit (GH-219 Task 13) ─────────────────
const { loadEnforcementContext } = require('../work-enforcement-context');
const { runPreflight } = require('../../lib/preflight');
const { appendEnforcementAudit } = require('../work-actions');
const { getCurrentTaskId } = require('../../lib/scripts/get-ticket-id');

// Tools that require /work-implement first
const BLOCKED_TOOLS = ['Write', 'Edit', 'MultiEdit'];

// ─────────────────────────────────────────────────────────────────────────────
// Protect only /work-implement command assets from being edited as an escape hatch
// ─────────────────────────────────────────────────────────────────────────────
const WORK_IMPLEMENT_UNLOCK_PHRASE = 'edit work-implement';
const PROTECTED_WORK_IMPLEMENT_PATTERNS = [
  /(?:^|\/)work-implement-enforce\.js$/i,
  /(?:^|\/)work-implement\.md$/i,
  /(?:^|\/)work-implement(?:\/|$)/i, // if you keep a folder for the command
];

// Files that are allowed without /work-implement (config, non-code files)
const ALLOWED_PATTERNS = [
  /\.md$/, // Markdown files
  /\.json$/, // JSON config files
  /\.ya?ml$/, // YAML files
  /\.env/, // Environment files
  /\.gitignore$/, // Git ignore
  /\.eslintrc/, // ESLint config
  /\.prettierrc/, // Prettier config
  /package\.json$/, // Package files
  /tsconfig/, // TypeScript config
  new RegExp(
    config.TASKS_BASE
      ? config.TASKS_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      : '__NO_TASKS_BASE__'
  ), // Global task tracking files
  /\.task-/, // Task files
  /\/__tests__\//, // Test directories
  /\.test\.[jt]sx?$/, // .test.js, .test.ts, .test.tsx
  /\.spec\.[jt]sx?$/, // .spec.js, .spec.ts, .spec.tsx
  /work-implement-enforce\.js$/, // This file specifically
];

function isProtectedWorkImplementFile(filePath) {
  if (!filePath) return false;
  return PROTECTED_WORK_IMPLEMENT_PATTERNS.some((p) => p.test(filePath));
}

function hasUnlockPhrase(transcriptPath, phrase) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    return content.includes(phrase);
  } catch {
    return false;
  }
}

/**
 * Check if currently inside a developer agent.
 * Only checks the tail of the transcript to avoid matching stale historical invocations.
 */
function isInsideDeveloperAgent(transcriptPath, opts = {}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return false;
  }

  try {
    const full = fs.readFileSync(transcriptPath, 'utf8');
    const tailBytes = typeof opts.tailBytes === 'number' ? opts.tailBytes : 20000;
    const content = full.slice(Math.max(0, full.length - tailBytes));
    const developerAgents = opts.allowAgents || [
      'developer-nodejs-tdd',
      'developer-react-senior',
      'developer-react-ui-architect',
      'developer-devops',
      ...(process.env.WORK_ARCHITECT_ENABLED === '1' ? ['code-architect'] : []),
    ];

    // Check if we're inside a developer agent
    for (const agent of developerAgents) {
      const frontmatterPattern = new RegExp(`^name:\\s*${agent}`, 'm');
      if (frontmatterPattern.test(content)) {
        return true;
      }
      // Also check if agent was invoked via Task
      const taskPattern = new RegExp(`"subagent_type"\\s*:\\s*"(work-workflow:)?${agent}"`, 'i');
      if (taskPattern.test(content)) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Check if the file being edited is allowed without /work-implement
 */
function isFileAllowed(filePath) {
  if (!filePath) return false;
  return ALLOWED_PATTERNS.some((pattern) => pattern.test(filePath));
}

// ─── State-based phase detection (GH-219 R1) ─────────────────────────────

/**
 * Determine if the workflow is in the implement phase using canonical state.
 * Replaces transcript-based `isWorkCommandActive`.
 *
 * Returns true when the workflow is past bootstrap and before commit.
 * This covers brief, spec, tasks, and implement phases — enforcement
 * starts early so all code-editing steps require /work-implement delegation.
 *
 * Uses step statuses rather than currentStep index for robustness
 * against step-registry additions.
 *
 * @param {object} ctx - EnforcementContext from loadEnforcementContext
 * @returns {boolean}
 */
function isInImplementPhase(ctx) {
  if (!ctx || !ctx.hasWorkflow) return false;
  const state = ctx.state;
  if (!state || state.status !== 'in_progress') return false;

  const stepStatus = state.stepStatus || {};
  const bootstrapDone = stepStatus.bootstrap === 'completed';
  const commitReached = stepStatus.commit === 'completed' || stepStatus.commit === 'in_progress';

  // After bootstrap (brief/spec/tasks) is done, before commit is reached
  return bootstrapDone && !commitReached;
}

/**
 * Check if /work-implement has been invoked using canonical state.
 * Replaces transcript-based `hasWorkImplementBeenInvoked`.
 *
 * Returns true when the implement step status is 'completed' or 'in_progress'.
 *
 * @param {object} ctx - EnforcementContext from loadEnforcementContext
 * @returns {boolean}
 */
function hasImplementBeenInvoked(ctx) {
  if (!ctx || !ctx.state) return false;
  const stepStatus = ctx.state.stepStatus || {};
  return stepStatus.implement === 'completed' || stepStatus.implement === 'in_progress';
}

/**
 * Create the audit callback for preflight (R13).
 * Wraps appendEnforcementAudit with the ticket ID and action context.
 *
 * @param {string} ticketId
 * @param {string} toolName
 * @param {string} filePath
 * @param {object} ctx - EnforcementContext
 * @returns {function}
 */
function createAuditCallback(ticketId, toolName, filePath, ctx) {
  return (entry) => {
    appendEnforcementAudit(ticketId, {
      origin: entry.origin || ctx.origin || 'user',
      task: null,
      phase: null,
      action: `${toolName}:${filePath || 'unknown'}`,
      allow: entry.decision === 'allow',
      reason:
        (entry.reasons || []).join('; ') || (entry.decision === 'allow' ? 'allowed' : 'denied'),
      outputPath: filePath || null,
    });
  };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const hookData = JSON.parse(input);
  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};
  const transcriptPath = hookData.transcript_path;

  // Only check blocked tools
  if (!BLOCKED_TOOLS.includes(toolName)) {
    process.exit(0);
  }

  // Get the file path being edited
  const filePath = toolInput.file_path || toolInput.path || '';

  // ── Hard protection: /work-implement assets ────────────────────────────
  // This runs regardless of /work being active, so it can't be used as an escape hatch.
  if (isProtectedWorkImplementFile(filePath)) {
    const unlocked = hasUnlockPhrase(transcriptPath, WORK_IMPLEMENT_UNLOCK_PHRASE);
    const insideNodejsTdd = isInsideDeveloperAgent(transcriptPath, {
      allowAgents: ['developer-nodejs-tdd'],
      tailBytes: 20000,
    });

    if (!unlocked || !insideNodejsTdd) {
      process.stderr.write(
        `/work-implement protection\n\n` +
          `Direct ${toolName} blocked for protected /work-implement assets:\n` +
          `  ${filePath}\n\n` +
          `To edit these files you must:\n` +
          `  1) include the exact unlock phrase in the prompt:\n` +
          `     "${WORK_IMPLEMENT_UNLOCK_PHRASE}"\n` +
          `  2) delegate via developer-nodejs-tdd\n`
      );
      didBlock = true;
      process.exit(2);
    }

    process.exit(0);
  }

  // ── State-based workflow detection (GH-219 R1) ─────────────────────────
  // Load enforcement context via adapter instead of reading transcript
  const ticketId = process.env.TICKET_ID || getCurrentTaskId();

  // If no ticket ID can be derived, no workflow to enforce
  if (!ticketId) {
    process.exit(0); // fail-open: no ticket context
  }

  const ctx = loadEnforcementContext(ticketId);

  // Check if we're in the implement phase using state
  if (!isInImplementPhase(ctx)) {
    process.exit(0);
  }

  // Allow config/non-code files (preserved from original)
  if (isFileAllowed(filePath)) {
    process.exit(0);
  }

  // Check if /work-implement has been invoked (state-based)
  if (hasImplementBeenInvoked(ctx)) {
    // ── Audit: allow path (R13) ────────────────────────────────────────
    const auditCb = createAuditCallback(ticketId, toolName, filePath, ctx);
    runPreflight(ctx, { audit: auditCb });
    process.exit(0);
  }

  // Check if inside a developer agent (which means /work-implement delegated properly)
  if (isInsideDeveloperAgent(transcriptPath)) {
    process.exit(0);
  }

  // ── Block with audit (R13) ───────────────────────────────────────────
  const auditCb = createAuditCallback(ticketId, toolName, filePath, ctx);
  runPreflight(
    {
      ...ctx,
      error: {
        code: 'IMPLEMENT_REQUIRED',
        message: '/work-implement not invoked',
        remediation: ['Invoke /work-implement first'],
      },
    },
    { audit: auditCb }
  );

  process.stderr.write(
    `/work Step 4 requires /work-implement\n\n` +
      `Direct ${toolName} blocked during /work implementation phase.\n\n` +
      `You MUST invoke /work-implement first:\n\n` +
      `  /work-implement <summary of ticket requirements>\n\n` +
      `This ensures:\n` +
      `  - Proper agent delegation (developer-*)\n` +
      `  - TodoWrite planning\n` +
      `  - Quality checks before proceeding\n\n` +
      `See /work Step 4 for details.\n`
  );
  didBlock = true;
  process.exit(2);
}

main().catch((err) => {
  logHookError(__filename, err);
  process.exit(didBlock ? 2 : 0);
});
