/**
 * protect-state-files.js
 *
 * Generic, reusable file protection for Claude Code hooks.
 * Blocks AI from writing to protected files via any vector:
 *   - Edit / Write / MultiEdit (file_path basename)
 *   - Bash shell operators (>, >>, tee, cp, mv, dd of=)
 *   - Node.js fs calls in Bash (writeFileSync, appendFileSync, etc.)
 *   - Script / inline-interpreter bypasses (see protect-script-bypass)
 *
 * Usage:
 *   const { createFileProtector, basenameProtector } = require('./lib/protect-state-files');
 *
 *   const protector = createFileProtector({
 *     isProtected: basenameProtector(new Set(['.secret.json', '.state.json'])),
 *     isExempt: (toolName, toolInput, hookData) => hookData?.isAdmin === true,
 *     formatMessage: (match, vector) => `BLOCKED: ${vector} to ${match}\n`,
 *   });
 *
 *   // In your hook handler:
 *   const result = protector.check(toolName, toolInput, hookData);
 *   if (result.blocked) {
 *     process.stderr.write(result.message);
 *     process.exit(2);
 *   }
 *   if (result.skipRemainingChecks) return; // file tool with no match — no further checks needed
 */

const path = require('path');
// Shared resolver for codex apply_patch write targets (design C6).
const { resolveApplyPatchTargets } = require('./apply-patch-targets');
const scriptBypass = require('./protect-script-bypass');

const { extractTokens, createBypassCheckers } = scriptBypass;

// ─── Constants ──────────────────────────────────────────────────────────────

/** Tools that write via file_path */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

/** Shell write operators — redirects, tee, cp, mv, dd.
 *  The negative-lookbehind `(?<![\d>])` on the leading `>` excludes fd-number
 *  redirects like `2>/dev/null`, `2>>/dev/null`, `1>>log`, which never write
 *  to a user-named target. The `>` exclusion handles the second `>` in `>>`
 *  cases like `2>>` (the second `>` is preceded by `>`, but the first `>` is
 *  preceded by a digit, so the whole operator is rejected). Real file writes
 *  (`> out`, `>> out`, `cmd &> out`) still match because they're preceded by
 *  whitespace or `&`, not a digit or `>`. */
const BASH_WRITE_OPS = /(?:(?<![\d>])>{1,2}|\btee\b|\bcp\b|\bmv\b|\bdd\b.*\bof=)/;

/** Node.js fs write calls executed via Bash (node -e, inline scripts) */
const NODE_FS_WRITES = /\b(?:writeFileSync|appendFileSync|writeFile|createWriteStream)\b/;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a Set of basenames from workflow definitions + extras.
 * Applies path.basename() defensively so callers can pass full paths or bare names.
 *
 * @param {Array<{stateFile: string, evidenceFile: string}>} workflows
 * @param {string[]} [extraFiles]
 * @returns {Set<string>}
 */
function buildProtectedBasenames(workflows, extraFiles = []) {
  return new Set([
    ...workflows.map((wf) => path.basename(wf.stateFile)),
    ...workflows.map((wf) => path.basename(wf.evidenceFile)),
    ...extraFiles.map((f) => path.basename(f)),
  ]);
}

/**
 * Create a basename-based isProtected function from a Set.
 * @param {Set<string>} basenames
 * @returns {(filePath: string) => string|null} — returns matched basename or null
 */
function basenameProtector(basenames) {
  return (filePath) => {
    const bn = path.basename(filePath);
    return basenames.has(bn) ? bn : null;
  };
}

// ─── Per-vector checks ──────────────────────────────────────────────────────

function blockedResult(ctx, match, vector, skipRemainingChecks) {
  return {
    blocked: true,
    match,
    vector,
    message: ctx.fmt(match, vector),
    skipRemainingChecks,
  };
}

/**
 * Vector 1b: codex apply_patch (write-kind, no file_path field). The
 * Edit/Write matcher lanes alias-fire for apply_patch on codex, but the
 * payload carries a raw patch instead of file_path. Check EVERY parsed
 * target; a multi-file patch touching one protected file blocks.
 * Unparseable targets fail OPEN here — these are advisory workflow
 * protectors, not the heimdall security boundary (design C6).
 */
function checkApplyPatchVector(ctx, toolInput, hookData) {
  for (const resolved of resolveApplyPatchTargets(toolInput?.command, hookData)) {
    const match = ctx.isProtected(resolved);
    if (match && !ctx.isExempt('apply_patch', toolInput, hookData)) {
      return blockedResult(ctx, match, 'apply_patch', true);
    }
  }
  return { blocked: false, skipRemainingChecks: true };
}

/** Vector 1: Edit / Write / MultiEdit. */
function checkFileToolVector(ctx, toolName, toolInput, hookData) {
  const filePath = toolInput?.file_path || '';
  if (!filePath) return { blocked: false, skipRemainingChecks: true };

  const match = ctx.isProtected(filePath);
  if (match && !ctx.isExempt(toolName, toolInput, hookData)) {
    return blockedResult(ctx, match, toolName, true);
  }
  return { blocked: false, skipRemainingChecks: true };
}

/**
 * Vector 2: Bash shell writes. Extract tokens, then normalize by stripping
 * operator prefixes — handles ">>.state.json", "of=.state.json",
 * ">.state.json", "x>>.state.json". Returns null when no token matches.
 */
function checkBashShellWrite(ctx, cmd, toolInput, hookData) {
  const hasShellWrite = BASH_WRITE_OPS.test(cmd);
  const hasNodeWrite = NODE_FS_WRITES.test(cmd);
  if (!hasShellWrite && !hasNodeWrite) return null;

  for (const token of extractTokens(cmd)) {
    const match = ctx.isProtected(token);
    if (match && !ctx.isExempt('Bash', toolInput, hookData)) {
      return blockedResult(ctx, match, 'Bash', false);
    }
  }
  return null;
}

/** Vectors 2–4 for Bash tool calls. */
function checkBashVector(ctx, toolInput, hookData) {
  const cmd = String(toolInput?.command || '');

  const shellResult = checkBashShellWrite(ctx, cmd, toolInput, hookData);
  if (shellResult) return shellResult;

  // Vector 3: script bypass — node/python/etc script with write ops.
  const scriptResult = ctx.checkScriptBypass(cmd, toolInput, hookData);
  if (scriptResult.blocked) return scriptResult;

  // Vector 4: inline interpreter bypass — python3 -c, ruby -e, perl -e.
  const inlineResult = ctx.checkInlineInterpreterBypass(cmd, toolInput, hookData);
  if (inlineResult.blocked) return inlineResult;

  return { blocked: false, skipRemainingChecks: false };
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a file protector instance.
 *
 * @param {object} opts
 * @param {(filePath: string) => string|null} opts.isProtected
 *   Returns a label (e.g. matched basename) if the file is protected, null otherwise.
 *   Called with the resolved file path from tool_input.
 *
 * @param {(toolName: string, toolInput: object, hookData?: object) => boolean} [opts.isExempt]
 *   Returns true if this specific call should be allowed despite targeting a protected file.
 *   Called before blocking. Defaults to () => false.
 *
 * @param {(match: string, vector: string) => string} [opts.formatMessage]
 *   Custom block message formatter. Receives the matched label and vector ('Edit'|'Bash'|etc).
 *   Defaults to a generic message.
 *
 * @param {string[]} [opts.trustedScriptRoots]
 *   Scripts whose realpath is inside any of these roots skip Vector 3
 *   (script-content bypass detection). This is how a hook tells the
 *   protector "these scripts are mine — they're the legitimate writers of
 *   the protected files." Without this, the hook deadlocks: it can't run
 *   its own orchestrator because the orchestrator's source mentions the
 *   protected basenames and contains write ops.
 *
 * @returns {{ check: (toolName: string, toolInput: object, hookData?: object) => CheckResult }}
 *
 * @typedef {object} CheckResult
 * @property {boolean} blocked — true if the operation should be blocked
 * @property {string} [match] — the label from isProtected (e.g. basename)
 * @property {string} [vector] — the attack vector ('Edit'|'Write'|'MultiEdit'|'Bash')
 * @property {string} [message] — formatted block message
 * @property {boolean} skipRemainingChecks — true for file tools (Edit/Write/MultiEdit) whether blocked or not
 */
function createFileProtector(opts) {
  const { isProtected, isExempt = () => false, formatMessage, trustedScriptRoots = [] } = opts;

  const defaultMessage = (match, vector) =>
    `BLOCKED: Direct ${vector} to ${match} is not allowed.\n` +
    `Protected files must only be modified through their designated scripts.\n`;

  const fmt = formatMessage || defaultMessage;

  const bypass = createBypassCheckers({ isProtected, isExempt, fmt, trustedScriptRoots });

  const ctx = {
    isProtected,
    isExempt,
    fmt,
    checkScriptBypass: bypass.checkScriptBypass,
    checkInlineInterpreterBypass: bypass.checkInlineInterpreterBypass,
  };

  function check(toolName, toolInput, hookData) {
    if (toolName === 'apply_patch') return checkApplyPatchVector(ctx, toolInput, hookData);
    if (FILE_WRITE_TOOLS.has(toolName)) {
      return checkFileToolVector(ctx, toolName, toolInput, hookData);
    }
    if (toolName === 'Bash') return checkBashVector(ctx, toolInput, hookData);
    return { blocked: false, skipRemainingChecks: false };
  }

  return {
    check,
    checkScriptBypass: bypass.checkScriptBypass,
    checkInlineInterpreterBypass: bypass.checkInlineInterpreterBypass,
  };
}

module.exports = {
  FILE_WRITE_TOOLS,
  BASH_WRITE_OPS,
  NODE_FS_WRITES,
  SCRIPT_WRITE_OPS: scriptBypass.SCRIPT_WRITE_OPS,
  INLINE_INTERPRETER_PATTERN: scriptBypass.INLINE_INTERPRETER_PATTERN,
  INLINE_INTERPRETER_WRITES: scriptBypass.INLINE_INTERPRETER_WRITES,
  BASE64_EVASION_PATTERN: scriptBypass.BASE64_EVASION_PATTERN,
  buildProtectedBasenames,
  basenameProtector,
  createFileProtector,
};
