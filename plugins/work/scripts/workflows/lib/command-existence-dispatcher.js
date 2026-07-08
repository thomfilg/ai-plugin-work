'use strict';

/**
 * lib/command-existence-dispatcher.js — GH-590 Task 7.
 *
 * `dispatch(command, ctx)` walks a shell command, splits it on top-level
 * operators (delegating to shell-tokenizer — NO regex for command splitting),
 * and for each segment classifies the first token and checks existence:
 *
 *   - `pnpm|npm|yarn <script>`     → script must be in manifest.scripts;
 *                                    on miss, suggest top-3 via Levenshtein.
 *   - `node|bash|sh|zsh <file>`    → file must exist under worktree.
 *   - `./path` or `dir/file`       → file must exist (exec-bit not enforced
 *                                    here; the smoke test layer covers it).
 *   - `eval "$VAR"` / any `$VAR`   → resolve via envrc-resolver, redispatch
 *                                    with a depth cap.
 *   - bare binary                  → resolve against $PATH via `fs.statSync`
 *                                    + fallback to manifest deps.
 *
 * Errors are COLLECTED (no short-circuit, AC9) and prefixed with the task
 * heading (P1.3). Manifest is memoized via `ctx.packageJson` (AC9, P2.1).
 *
 * Security (spec §Security):
 *   - No command execution at validation time. The validator never spawns a
 *     subprocess. Binary existence is determined by walking `process.env.PATH`
 *     and probing each candidate with `fs.statSync` — no shell, no `exec`.
 */

const fs = require('node:fs');
const path = require('node:path');

const { splitTopLevelCommands } = require('./shell-tokenizer');
const { nearest } = require('./levenshtein');
const { findNearestEnvrc, findNearestPackageJson, resolveVar } = require('./envrc-resolver');
const {
  stripQuotes,
  argvSplit,
  containsVarRef,
  extractFirstVarName,
} = require('./dispatcher-helpers');

const MAX_REDISPATCH_DEPTH = 8;
const SCRIPT_RUNNERS = new Set(['pnpm', 'npm', 'yarn']);
const INTERPRETERS = new Set(['node', 'bash', 'sh', 'zsh']);
// Shell builtins that never resolve on PATH. `set` segments come from the
// strict-mode prefix (`set -e; set -o pipefail; ...`) that
// lib/test-strategy.js prepends to chained custom commands (W9) — skip them
// instead of emitting a false "command not found" at the draft gate.
const SHELL_BUILTINS = new Set(['set']);

function prefixHeading(taskHeading, msg) {
  if (!taskHeading) {
    return msg;
  }
  return `${taskHeading}: ${msg}`;
}

function loadManifest(ctx) {
  if (ctx.packageJson && typeof ctx.packageJson === 'object' && ctx.packageJson.manifest) {
    return ctx.packageJson;
  }
  const found = findNearestPackageJson(ctx.worktree);
  if (found) {
    ctx.packageJson = found;
  }
  return found;
}

function loadEnvrc(ctx) {
  if (ctx.envrc && typeof ctx.envrc === 'object' && ctx.envrc.vars) {
    return ctx.envrc;
  }
  const found = findNearestEnvrc(ctx.worktree);
  if (found) {
    ctx.envrc = found;
  }
  return found;
}

function hasManifestDep(manifest, binary) {
  if (!manifest) {
    return false;
  }
  const buckets = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  for (const b of buckets) {
    if (manifest[b] && Object.prototype.hasOwnProperty.call(manifest[b], binary)) {
      return true;
    }
  }
  return false;
}

function checkBinaryOnPath(binary) {
  // No subprocess: walk `process.env.PATH` and stat each candidate. This is
  // the secure equivalent of `command -v <binary>` without invoking a shell.
  const PATH = process.env.PATH || '';
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '').split(';') : [''];
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, binary + ext);
      try {
        const st = fs.statSync(candidate);
        if (st.isFile()) {
          return true;
        }
      } catch {
        // not found, continue
      }
    }
  }
  return false;
}

// Sub-tokens that aren't scripts — they invoke binaries, not package.json
// scripts. `pnpm exec <bin>`, `npm exec <bin>`, `pnpm dlx <bin>`,
// `yarn dlx <bin>`, `npx <bin>` all hand off to a binary that we should
// validate against PATH + manifest deps. `run` is the explicit run form
// where the next token IS the script name.
const PASS_THROUGH_TO_BINARY = new Set(['exec', 'dlx']);

function _dispatchPassThroughBinary(runner, sub, argv, ctx, errors) {
  if (argv.length < 3) {
    errors.push(
      prefixHeading(ctx.taskHeading, `${runner} ${sub} invocation missing a binary name`)
    );
    return;
  }
  dispatchBareBinary(argv.slice(2), ctx, errors);
}

function _resolveScriptIndex(argv) {
  const sub = stripQuotes(argv[1] || '');
  return sub === 'run' ? 2 : 1;
}

function _emitMissingScript(runner, scriptName, scripts, ctx, errors) {
  const haystack = Object.keys(scripts);
  const cache = ctx.__levCache || (ctx.__levCache = new Map());
  const suggestions = nearest(scriptName, haystack, 3, { cache });
  const suggestionText =
    suggestions.length > 0 ? ` (did you mean: ${suggestions.join(', ')}?)` : '';
  errors.push(
    prefixHeading(
      ctx.taskHeading,
      `${runner} script "${scriptName}" is not in package.json scripts${suggestionText}`
    )
  );
}

function dispatchScriptRunner(argv, ctx, errors) {
  const runner = argv[0];
  const sub = stripQuotes(argv[1] || '');
  if (PASS_THROUGH_TO_BINARY.has(sub))
    return _dispatchPassThroughBinary(runner, sub, argv, ctx, errors);
  const scriptIdx = _resolveScriptIndex(argv);
  if (argv.length <= scriptIdx) {
    errors.push(prefixHeading(ctx.taskHeading, `${runner} invocation missing a script name`));
    return;
  }
  const scriptName = stripQuotes(argv[scriptIdx]);
  const pkg = loadManifest(ctx);
  if (!pkg || !pkg.manifest) {
    errors.push(
      prefixHeading(ctx.taskHeading, `${runner} ${scriptName}: no package.json found in worktree`)
    );
    return;
  }
  const scripts = pkg.manifest.scripts || {};
  if (Object.prototype.hasOwnProperty.call(scripts, scriptName)) return;
  _emitMissingScript(runner, scriptName, scripts, ctx, errors);
}

function dispatchInterpreter(argv, ctx, errors) {
  const interp = argv[0];
  if (argv.length < 2) {
    // `node --version` etc. — treat as a bare-binary check (interp is on PATH).
    if (!checkBinaryOnPath(interp)) {
      errors.push(prefixHeading(ctx.taskHeading, `${interp}: command not found on PATH`));
    }
    return;
  }
  // Skip flags; find the first non-flag positional which we treat as the file.
  let target = null;
  for (let i = 1; i < argv.length; i += 1) {
    const a = stripQuotes(argv[i]);
    if (!a.startsWith('-')) {
      target = a;
      break;
    }
  }
  if (target === null) {
    // All flags (e.g. `node --version`). Treat interpreter itself as binary.
    if (!checkBinaryOnPath(interp)) {
      errors.push(prefixHeading(ctx.taskHeading, `${interp}: command not found on PATH`));
    }
    return;
  }
  const abs = path.isAbsolute(target) ? target : path.join(ctx.worktree, target);
  if (!fs.existsSync(abs)) {
    errors.push(prefixHeading(ctx.taskHeading, `${interp} ${target}: file does not exist`));
  }
}

function dispatchFilePath(argv, ctx, errors) {
  const target = stripQuotes(argv[0]);
  const abs = path.isAbsolute(target) ? target : path.join(ctx.worktree, target);
  if (!fs.existsSync(abs)) {
    errors.push(prefixHeading(ctx.taskHeading, `${target}: file does not exist`));
  }
}

function dispatchBareBinary(argv, ctx, errors) {
  const binary = stripQuotes(argv[0]);
  const pkg = loadManifest(ctx);
  const manifest = pkg ? pkg.manifest : null;
  if (manifest && hasManifestDep(manifest, binary)) {
    return;
  }
  if (checkBinaryOnPath(binary)) {
    // AC6: PATH-resolution alone is sufficient to pass. A binary that is
    // on PATH but not declared in package.json deps must NOT produce an
    // error — the failure condition is the AND of (not on PATH) AND (not
    // declared). See GH-590 brief AC6.
    return;
  }
  errors.push(
    prefixHeading(
      ctx.taskHeading,
      `${binary}: command not found on PATH and not declared in package.json dependencies`
    )
  );
}

// Variables bound at runtime by the orchestrator (not in `.envrc`). When the
// expanded envelope template references `$CHANGED_FILES`, the validator must
// not flag it as missing — it's set by the caller at exec time. Keep this
// list narrow; add only well-known orchestrator placeholders.
const RUNTIME_PLACEHOLDER_VARS = new Set(['CHANGED_FILES', 'TICKET', 'TICKET_ID']);

function dispatchVarSegment(segment, ctx, errors, depth) {
  const envrc = loadEnvrc(ctx);
  const name = extractFirstVarName(segment);
  if (!name) {
    errors.push(prefixHeading(ctx.taskHeading, `unresolved variable reference in: ${segment}`));
    return;
  }
  if (RUNTIME_PLACEHOLDER_VARS.has(name)) {
    // Runtime-bound: substitute a benign sentinel so the surrounding command
    // (e.g. `pnpm test $CHANGED_FILES`) still gets its first-token script /
    // binary check. Strip both `${VAR}` and `$VAR` forms.
    const sentinel = '__runtime__';
    const stripped = segment
      .replace(new RegExp(`\\$\\{${name}\\}`, 'g'), sentinel)
      .replace(new RegExp(`\\$${name}\\b`, 'g'), sentinel);
    // If after substitution another $VAR ref remains, recurse so each ref
    // takes its own dispatch path; otherwise treat the cleaned segment as a
    // normal command.
    dispatchInternal(stripped, ctx, errors, depth + 1);
    return;
  }
  if (!envrc) {
    errors.push(prefixHeading(ctx.taskHeading, `$${name}: no .envrc found to resolve variable`));
    return;
  }
  const resolved = resolveVar(name, envrc);
  if (resolved === null || resolved === undefined || resolved === '') {
    // resolveVar returns null when an inner reference can't be fully resolved
    // (e.g. `TEST_UNIT_COMMAND='pnpm test $CHANGED_FILES'` where CHANGED_FILES
    // is a runtime placeholder, not an .envrc var). Fall back to the raw
    // template if defined — the recursive dispatch will then route the inner
    // $VAR through this same guard, where runtime placeholders are accepted.
    const raw = envrc.vars && envrc.vars[name];
    if (typeof raw === 'string' && raw.length > 0) {
      dispatchInternal(raw, ctx, errors, depth + 1);
      return;
    }
    errors.push(prefixHeading(ctx.taskHeading, `$${name}: unresolved or empty in .envrc`));
    return;
  }
  // Recursively redispatch the resolved command string.
  dispatchInternal(resolved, ctx, errors, depth + 1);
}

function _isPathLike(token) {
  return token.startsWith('./') || token.startsWith('/') || token.includes('/');
}

function _handleEval(argv, ctx, errors, depth) {
  const body = stripQuotes(argv.slice(1).join(' '));
  if (containsVarRef(body)) {
    dispatchVarSegment(body, ctx, errors, depth);
  } else {
    dispatchInternal(body, ctx, errors, depth + 1);
  }
}

function _classifyAndDispatch(argv, ctx, errors, depth) {
  const first = stripQuotes(argv[0]);
  if (first === 'eval' && argv.length >= 2) {
    _handleEval(argv, ctx, errors, depth);
    return;
  }
  const rest = [first, ...argv.slice(1)];
  if (SCRIPT_RUNNERS.has(first)) return dispatchScriptRunner(rest, ctx, errors);
  if (INTERPRETERS.has(first)) return dispatchInterpreter(rest, ctx, errors);
  // `npx <bin>` validates <bin> against PATH + manifest deps, mirroring AC's
  // table entry for npx. Skip leading flags like `npx --yes <bin>`.
  if (first === 'npx') {
    let i = 1;
    while (i < argv.length && stripQuotes(argv[i]).startsWith('-')) i += 1;
    if (i >= argv.length) {
      errors.push(prefixHeading(ctx.taskHeading, 'npx invocation missing a binary name'));
      return;
    }
    return dispatchBareBinary(argv.slice(i), ctx, errors);
  }
  if (_isPathLike(first)) return dispatchFilePath(rest, ctx, errors);
  return dispatchBareBinary(rest, ctx, errors);
}

function dispatchSegment(segment, ctx, errors, depth) {
  const trimmed = segment.trim();
  if (trimmed === '') return;
  if (containsVarRef(trimmed)) {
    dispatchVarSegment(trimmed, ctx, errors, depth);
    return;
  }
  const argv = argvSplit(trimmed);
  if (argv.length === 0) return;
  if (SHELL_BUILTINS.has(stripQuotes(argv[0]))) return;
  _classifyAndDispatch(argv, ctx, errors, depth);
}

function dispatchInternal(command, ctx, errors, depth) {
  if (depth > MAX_REDISPATCH_DEPTH) {
    errors.push(prefixHeading(ctx.taskHeading, `redispatch depth cap exceeded for: ${command}`));
    return;
  }
  // AC8: reject empty / prose-only bodies BEFORE splitting.
  if (depth === 0) {
    const trimmedCmd = (command || '').trim();
    if (trimmedCmd === '') {
      errors.push(prefixHeading(ctx.taskHeading, 'empty command body'));
      return;
    }
  }
  const segments = splitTopLevelCommands(command);
  if (segments.length === 0) {
    if (depth === 0) {
      errors.push(prefixHeading(ctx.taskHeading, 'empty command body'));
    }
    return;
  }
  for (const seg of segments) {
    dispatchSegment(seg, ctx, errors, depth);
  }
}

/**
 * Public entry point.
 *
 * @param {string} command
 * @param {{ worktree: string, packageJson?: object|null, envrc?: object|null, taskHeading?: string }} ctx
 * @returns {{ ok: boolean, errors: string[] }}
 */
function dispatch(command, ctx) {
  const errors = [];
  const workingCtx = ctx && typeof ctx === 'object' ? ctx : { worktree: process.cwd() };
  if (!workingCtx.worktree) {
    workingCtx.worktree = process.cwd();
  }
  dispatchInternal(command, workingCtx, errors, 0);
  return { ok: errors.length === 0, errors };
}

module.exports = {
  dispatch,
  MAX_REDISPATCH_DEPTH,
};
