/**
 * task-scope-type-guard.js
 *
 * GH-528 item 5 helpers for the protect-task-scope hook (Gate D):
 *
 *   - per-Type closed-allowlist decision (tests-only / docs / config / ci
 *     restrict writes to their scopePatterns in
 *     skills/split-in-tasks/lib/task-types.js)
 *   - `### Type` line edit guard: the planner authors Type; the implementer
 *     must not flip it mid-implement (would bypass the per-Type TDD gate).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { matchesTypeScope, scopeRulesFor, isTestFilePath } = require(
  path.join(__dirname, '..', '..', '..', '..', 'skills', 'split-in-tasks', 'lib', 'task-types')
);

/**
 * Per-Type closed-allowlist types. For these, the write target must match
 * the Type's scopePatterns regex in addition to the active task's filesInScope.
 * Types not in this set keep the existing behavior (filesInScope check only).
 */
const TYPE_ENFORCED_KINDS = new Set(['tests-only', 'docs', 'config', 'ci']);

function typeAllowlistDecision(type, relTarget) {
  if (!type || !TYPE_ENFORCED_KINDS.has(type)) return { blocked: false };
  const rules = scopeRulesFor(type);
  if (!rules || !rules.scopePatterns) return { blocked: false };
  if (matchesTypeScope(type, relTarget)) {
    // For tests-only also require the target to be a test file. matchesTypeScope
    // already enforces this via the TEST_FILE_PATTERN pattern but keep an
    // explicit check so the error message is precise.
    if (type === 'tests-only' && !isTestFilePath(relTarget)) {
      return {
        blocked: true,
        reason:
          `Type=tests-only restricts writes to *.test.* / *.spec.* files. ` +
          `Target "${relTarget}" is not a test file.`,
      };
    }
    return { blocked: false };
  }
  return {
    blocked: true,
    reason:
      `Type=${type} restricts writes to a closed allowlist (see ` +
      `plugins/work/skills/split-in-tasks/lib/task-types.js). ` +
      `Target "${relTarget}" is not in the ${type} allowlist.`,
  };
}

/**
 * Detect attempts to edit the `### Type` line inside a tasks.md write. For
 * Write tool calls targeting tasks.md, reject when the new content's
 * `### Type` line differs from the on-disk version.
 *
 * Returns `{ blocked: true, reason }` to block, `{ blocked: false }` to allow.
 */
function checkWriteTypeLines(toolInput, onDiskTypes) {
  const newContent = (toolInput.content || '').toString();
  const newTypes = extractTypeLines(newContent);
  if (typesEqual(onDiskTypes, newTypes)) return { blocked: false };
  return {
    blocked: true,
    reason:
      `protect-task-scope: refusing to modify \`### Type\` lines in tasks.md ` +
      `mid-implement. The planner sets Type; the implementer cannot change it ` +
      `(would bypass the per-Type TDD contract). On disk: ${JSON.stringify(onDiskTypes)} ` +
      `→ new: ${JSON.stringify(newTypes)}.`,
  };
}

/**
 * Apply a single Edit patch in memory using the same semantics Claude Code's
 * Edit tool uses: literal string replacement, first occurrence only unless
 * `replace_all` is true. Returns the patched content, or null when the patch
 * cannot be applied (old_string not found) — caller treats null as a fall-
 * through (no change simulated, the real tool would error).
 */
// GH-528 round-2 follow-up note: when an Edit/MultiEdit's `old_string` is
// not found, applyEditPatch returns null and the caller skips that single
// patch in the simulation. The real Edit tool errors on missing
// `old_string` and aborts the whole tool call, so the simulator's "skip
// and continue" can diverge if a later patch in a MultiEdit was authored
// against the expected post-first-patch state. In practice the divergence
// can only ALLOW patches the real tool would reject (the real tool errors
// before applying anything; the simulator might allow a residual
// Type-flipping patch through if it happens to apply against the
// unchanged file). The block-direction risk is the one we care about —
// the Type-line guard's final equality check still compares the simulated
// post-state Type lines against on-disk, so a Type flip still gets
// caught regardless of upstream patch sequencing. Worth a note for
// future maintainers.
function applyEditPatch(content, edit) {
  const oldStr = (edit.old_string || '').toString();
  const newStr = (edit.new_string || '').toString();
  if (!oldStr) return content;
  if (edit.replace_all) {
    return content.split(oldStr).join(newStr);
  }
  const idx = content.indexOf(oldStr);
  if (idx === -1) return null;
  return content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
}

/**
 * Cursor[bot] Comment 5 (GH-528): value-only patches must be detected.
 *
 * The old heuristic (string-match `### Type` in patch text) missed:
 *   - `old: "tdd-code", new: "docs"` (no header in patch strings)
 *   - whitespace tricks (`old: "tdd-code  ", new: "docs"`)
 *   - MultiEdit split across two edits that combine to flip the value
 *
 * The source of truth is "what does the resolved file look like after the
 * patch?" — so we read tasks.md from disk, simulate the Edit/MultiEdit, and
 * compare extracted `### Type` lines before vs after. If they differ, block.
 *
 * This function is invoked only when the write target IS tasks.md (caller
 * guarantees), so the cost of reading + simulating is bounded.
 */
function checkEditTypeLines(toolName, toolInput, onDiskContent, onDiskTypes) {
  const edits =
    toolName === 'Edit' ? [toolInput] : Array.isArray(toolInput.edits) ? toolInput.edits : [];
  if (edits.length === 0) return { blocked: false };

  let simulated = onDiskContent;
  for (const edit of edits) {
    const next = applyEditPatch(simulated, edit);
    // null = old_string not found; the real tool would error, so the file
    // wouldn't change. Skip this edit in the simulation.
    if (next !== null) simulated = next;
  }

  const newTypes = extractTypeLines(simulated);
  if (typesEqual(onDiskTypes, newTypes)) return { blocked: false };

  return {
    blocked: true,
    reason:
      `protect-task-scope: refusing to edit \`### Type\` line in tasks.md ` +
      `mid-implement. Type is planner-authored. On disk: ${JSON.stringify(onDiskTypes)} ` +
      `→ after patch: ${JSON.stringify(newTypes)}.`,
  };
}

/** Resolve the tool call's target path, or null when it carries none. */
function resolveTypeGuardTarget(toolInput, workDir) {
  const target = (toolInput.file_path || '').toString();
  if (!target) return null;
  return path.isAbsolute(target) ? target : path.resolve(workDir, target);
}

function typeLineGuard(toolName, toolInput, workDir, tasksDir) {
  if (!toolInput || !tasksDir) return { blocked: false };
  const resolvedTarget = resolveTypeGuardTarget(toolInput, workDir);
  const tasksMdPath = path.resolve(tasksDir, 'tasks.md');
  if (!resolvedTarget || resolvedTarget !== tasksMdPath) return { blocked: false };

  let onDisk = '';
  try {
    onDisk = fs.readFileSync(tasksMdPath, 'utf8');
  } catch {
    return { blocked: false };
  }
  const onDiskTypes = extractTypeLines(onDisk);

  if (toolName === 'Write') return checkWriteTypeLines(toolInput, onDiskTypes);
  if (toolName === 'Edit' || toolName === 'MultiEdit') {
    return checkEditTypeLines(toolName, toolInput, onDisk, onDiskTypes);
  }
  return { blocked: false };
}

// GH-528 round-2 follow-up note: extracted Type values are normalized to
// lowercase. typesEqual is a case-sensitive string compare against the
// already-normalized arrays, so case-only patches (e.g. `tdd-code` →
// `TDD-Code`) are treated as no-ops. That is intentional — every
// downstream Type consumer (gateContractFor, lint-type-ac-consistency,
// readActiveTaskType in tdd-phase-state.js) also lowercases the value
// before comparing against the closed enum. Blocking case-only edits
// would create false positives without closing any real bypass.
function extractTypeLines(md) {
  const out = [];
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (/^###\s+Type\s*$/i.test(lines[i].trim())) {
      // Find the next non-blank line.
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j].trim();
        if (!next) continue;
        if (next.startsWith('#')) {
          out.push('');
          break;
        }
        out.push(next.toLowerCase());
        break;
      }
    }
  }
  return out;
}

function typesEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

module.exports = {
  TYPE_ENFORCED_KINDS,
  typeAllowlistDecision,
  typeLineGuard,
  extractTypeLines,
};
