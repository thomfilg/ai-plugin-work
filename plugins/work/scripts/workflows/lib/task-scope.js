/**
 * task-scope.js
 *
 * Gate C — pure validators for the per-task `Files in scope` and
 * `Files explicitly out of scope` declarations. Used by the implement-time
 * gate to refuse dispatch when scope sections are missing or empty, and
 * by Gate D's hook to compute the active envelope.
 *
 * The parser lives in `scripts/workflows/work/task-parser.js`. This file
 * only validates the already-parsed objects.
 */

'use strict';

const path = require('path');

/**
 * Returns true when a tasks.md scope/dep entry is an absolute path
 * (POSIX `/...` or Windows `C:\...`). Cross-task / scope entries must
 * always be repo-relative; absolute paths bypass the worktree envelope.
 *
 * @param {string} entry
 * @returns {boolean}
 */
function _isAbsolutePathEntry(entry) {
  if (typeof entry !== 'string' || !entry) return false;
  if (path.isAbsolute(entry)) return true;
  if (/^[A-Za-z]:[\\/]/.test(entry)) return true; // Windows drive
  return false;
}

/**
 * Validate one task object's scope sections.
 *
 * @param {{ num:number, filesInScope?:string[], filesOutOfScope?:string[] }} task
 * @returns {string[]} validation error messages (empty when valid)
 */
function validateTask(task) {
  const errors = [];
  if (!task || typeof task !== 'object') {
    return ['task must be an object'];
  }
  const label = `Task ${task.num ?? '?'}`;

  // Checkpoint tasks don't ship code, so the `Files in scope` envelope is
  // not meaningful for them. The implement-gate already exempts them from
  // TDD evidence; this matches that behavior at Gate C.
  const taskType = typeof task.type === 'string' ? task.type.toLowerCase().trim() : null;
  const isCheckpoint = taskType === 'checkpoint' || task.isCheckpoint === true;
  if (isCheckpoint) {
    return errors;
  }

  // Legacy fallback: tasks written before Gate C may carry `### Suggested Scope`
  // instead of `### Files in scope`. Accept that as evidence of scope intent
  // and ONLY error when BOTH are missing/empty. New tasks SHOULD use
  // `### Files in scope`; the warning surfaces via downstream check-step
  // tooling (Gate E), not as a hard implement-step block.
  const hasInScope = Array.isArray(task.filesInScope) && task.filesInScope.length > 0;
  const hasLegacyScope =
    typeof task.suggestedScope === 'string' && task.suggestedScope.trim().length > 0;
  if (!hasInScope && !hasLegacyScope) {
    errors.push(
      `${label} is missing both \`### Files in scope\` AND \`### Suggested Scope\` (need at least one)`
    );
  }
  // `### Files explicitly out of scope` is forward-looking and not required
  // for legacy tasks. New tasks (those with `### Files in scope`) SHOULD
  // include it; tolerate absence here and surface in Gate E review.
  if (task.filesOutOfScope !== undefined && !Array.isArray(task.filesOutOfScope)) {
    errors.push(`${label} has malformed \`### Files explicitly out of scope\` section`);
  }

  // GH-392 follow-up: Cross-Task Dependencies must be repo-relative. An
  // absolute path (POSIX `/foo` or Windows `C:\foo`) would let a task widen
  // the protect-task-scope envelope to anywhere on disk via the cross-task
  // allow-list. Reject at tasks-gate parse time — runtime is too late.
  if (Array.isArray(task.crossTaskDeps)) {
    for (const entry of task.crossTaskDeps) {
      if (_isAbsolutePathEntry(entry)) {
        errors.push(
          `${label} \`### Cross-Task Dependencies\` entry "${entry}" is an absolute path. ` +
            'Cross-task dep entries must be repo-relative (e.g. `src/shared/schema.ts`).'
        );
      }
    }
  }
  // Same rule for filesInScope / filesOutOfScope as defence-in-depth — an
  // absolute glob there has no legitimate meaning and would either match
  // nothing or, worse, slip past the worktree envelope.
  for (const field of ['filesInScope', 'filesOutOfScope']) {
    const arr = task[field];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (_isAbsolutePathEntry(entry)) {
        errors.push(
          `${label} \`### ${field === 'filesInScope' ? 'Files in scope' : 'Files explicitly out of scope'}\` entry "${entry}" is an absolute path. Entries must be repo-relative.`
        );
      }
    }
  }
  return errors;
}

/**
 * Extract the CHANGED_FILES list from a task's `### Test Command`. Returns
 * an empty array if the command doesn't follow the canonical
 * `CHANGED_FILES="<list>" eval "$TEST_*_COMMAND"` form.
 *
 * Preserved for backward compatibility with read-only consumers
 * (`task-next.js`, `implement-gate.js`, `transition-step.js`). New per-eval
 * validation lives in `extractEvalScopePairs` + `validateTaskTestScope`.
 *
 * @param {string|null|undefined} testCommand
 * @returns {string[]}
 */
function extractChangedFilesFromTestCommand(testCommand) {
  if (typeof testCommand !== 'string' || !testCommand) return [];
  // Match CHANGED_FILES="..." or CHANGED_FILES='...'. Tolerant of leading
  // whitespace and `&&`/`;` chains — we only need the FIRST assignment to
  // judge what the gate will execute against.
  const m = testCommand.match(/CHANGED_FILES\s*=\s*(['"])([\s\S]*?)\1/);
  if (!m) return [];
  return m[2].split(/\s+/).filter(Boolean);
}

/**
 * Walk every `eval "$TEST_*_COMMAND"` occurrence in a Test Command and pair
 * it with the nearest preceding `CHANGED_FILES=...` assignment in the SAME
 * segment. Segments are separated by `&&`, `;`, or `\`-continued newlines.
 *
 * Returns an array of `{ eval, changedFiles, offset }` entries — one per
 * eval occurrence. `changedFiles` is the matched value string or `null`
 * when no CHANGED_FILES precedes the eval in its segment.
 *
 * @param {string|null|undefined} testCommand
 * @returns {Array<{ eval:string, changedFiles:string|null, offset:number }>}
 */
function extractEvalScopePairs(testCommand) {
  if (typeof testCommand !== 'string' || !testCommand) return [];
  // Normalise `\<newline>` continuations to whitespace, then split on
  // `&&` and `;` (top-level only — bash subshells/quotes are out of scope
  // for the canonical Test Command form).
  const flat = testCommand.replace(/\\\n/g, ' ');
  const segments = [];
  let cursor = 0;
  const sepRe = /&&|;/g;
  let m;
  while ((m = sepRe.exec(flat)) !== null) {
    segments.push({ text: flat.slice(cursor, m.index), offset: cursor });
    cursor = m.index + m[0].length;
  }
  segments.push({ text: flat.slice(cursor), offset: cursor });

  const evalRe = /eval\s+(['"])\$TEST_[A-Z0-9_]+_COMMAND\1/g;
  const cfRe = /CHANGED_FILES\s*=\s*(['"])([\s\S]*?)\1/g;
  const pairs = [];
  for (const seg of segments) {
    let em;
    const cfMatches = [];
    let cf;
    cfRe.lastIndex = 0;
    while ((cf = cfRe.exec(seg.text)) !== null) {
      cfMatches.push({ value: cf[2], index: cf.index });
    }
    evalRe.lastIndex = 0;
    while ((em = evalRe.exec(seg.text)) !== null) {
      // Find the nearest CHANGED_FILES preceding this eval within the segment.
      let nearest = null;
      for (const c of cfMatches) {
        if (c.index < em.index) nearest = c;
      }
      pairs.push({
        eval: em[0].match(/\$TEST_[A-Z0-9_]+_COMMAND/)[0],
        changedFiles: nearest ? nearest.value : null,
        offset: seg.offset + em.index,
      });
    }
  }
  return pairs;
}

/**
 * Check whether a candidate file path is covered by any of the task's
 * `Files in scope` glob patterns. Performs a simple prefix/segment match
 * sufficient for tasks.md authoring (full glob matching happens at
 * Gate D runtime via micromatch).
 *
 * Returns true when the candidate equals a scope entry, sits under one
 * (treating `**` as a wildcard), or matches the directory prefix of a
 * scope entry that ends with a glob.
 *
 * @param {string} candidate
 * @param {string[]} scopeGlobs
 * @returns {boolean}
 */
function fileMatchesScope(candidate, scopeGlobs) {
  if (!candidate || !Array.isArray(scopeGlobs) || scopeGlobs.length === 0) return false;
  const norm = String(candidate).replace(/^\.\//, '');
  for (const raw of scopeGlobs) {
    if (typeof raw !== 'string' || !raw) continue;
    const glob = raw.replace(/^\.\//, '');
    if (glob === norm) return true;
    // `lib/foo/**` or `lib/foo/**/*.ts` → match anything under lib/foo/
    const starIdx = glob.indexOf('*');
    if (starIdx > 0) {
      const prefix = glob.slice(0, starIdx);
      if (norm.startsWith(prefix)) return true;
    } else if (glob.endsWith('/')) {
      if (norm.startsWith(glob)) return true;
    }
  }
  return false;
}

/**
 * Recognise a test file by extension.
 */
const TEST_FILE_EXT_RE = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * Decide whether a test file path follows the project's integration-test
 * naming convention. Integration tests must be EITHER:
 *   - filename ends with `.integration.test.<ext>` / `.integration.spec.<ext>`, or
 *   - path contains an `integration/` directory segment.
 *
 * Unit tests must do NEITHER (they live under any directory but never
 * inside `integration/` and never carry the `.integration.` infix).
 *
 * This naming rule is what lets the vitest configs route a test file to
 * the correct runner; it is also how split-in-tasks declares per-task gate
 * granularity. Misnamed files silently fall into the wrong runner and the
 * gate either skips them or runs them against the wrong fixtures.
 *
 * @param {string} candidate
 * @returns {boolean}
 */
function isIntegrationTestPath(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  if (!TEST_FILE_EXT_RE.test(candidate)) return false;
  if (/\.integration\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(candidate)) return true;
  if (/(?:^|\/)integration\//.test(candidate)) return true;
  return false;
}

/**
 * Decide whether a test file path follows the project's e2e naming convention.
 *   - filename ends with `.e2e.test.<ext>` / `.e2e.spec.<ext>`, OR
 *   - path contains an `e2e/` directory segment.
 */
function isE2eTestPath(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  if (!TEST_FILE_EXT_RE.test(candidate)) return false;
  if (/\.e2e\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(candidate)) return true;
  if (/(?:^|\/)e2e\//.test(candidate)) return true;
  return false;
}

/**
 * Decide whether the Test Command targets the integration runner.
 */
function usesIntegrationRunner(testCommand) {
  return typeof testCommand === 'string' && /\$TEST_INTEGRATION_COMMAND\b/.test(testCommand);
}

/**
 * Decide whether the Test Command targets the unit runner.
 */
function usesUnitRunner(testCommand) {
  return typeof testCommand === 'string' && /\$TEST_UNIT_COMMAND\b/.test(testCommand);
}

/**
 * Decide whether the Test Command targets the e2e runner.
 */
function usesE2eRunner(testCommand) {
  return typeof testCommand === 'string' && /\$TEST_E2E_COMMAND\b/.test(testCommand);
}

/**
 * Decide whether the Test Command is a recognised test-runner invocation
 * (unit / integration / e2e) — i.e. it would actually execute tests.
 * Plain typecheck/lint/build commands are NOT test invocations, so they
 * cannot serve as a task's behavior gate.
 */
function usesRecognisedRunner(testCommand) {
  return (
    usesUnitRunner(testCommand) || usesIntegrationRunner(testCommand) || usesE2eRunner(testCommand)
  );
}

/**
 * Detect Test Commands that pretend to be a test gate but actually run
 * something that never asserts behavior — typecheck, lint, build, format,
 * a bare `true`, etc. Returns a short category name when matched, null
 * otherwise.
 *
 * The check is conservative: it only flags commands that are CLEARLY
 * non-test (no test runner referenced; primary verb is a compile/lint
 * tool). Hardcoded runner invocations like `pnpm test foo.ts` aren't
 * touched here (handled by the opt-out clause in SKILL.md).
 */
function detectNonTestCommand(testCommand) {
  if (typeof testCommand !== 'string' || !testCommand.trim()) return null;
  if (usesRecognisedRunner(testCommand)) return null;
  const lower = testCommand.toLowerCase();
  // Hardcoded test-runner invocations still count as tests, even without env vars
  if (
    /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test|vitest|jest|playwright|cypress|pw\s+test)\b/.test(
      lower
    )
  ) {
    return null;
  }
  if (
    /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?typecheck\b|\btsc\b(?!.*-p\s+tsconfig\.test)/.test(lower)
  ) {
    return 'typecheck-only';
  }
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:lint|format|prettier|biome|eslint)\b/.test(lower)) {
    return 'lint-only';
  }
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?build\b/.test(lower)) {
    return 'build-only';
  }
  if (/^\s*(?:true|:|exit\s+0)\s*;?\s*$/.test(testCommand)) {
    return 'noop';
  }
  return null;
}

/**
 * Verify the task's Test Command CHANGED_FILES list is fully covered by
 * this task's `### Files in scope`. When a CHANGED_FILES path is owned
 * by another task, the test will execute through that other task's code
 * — and the gate cannot pass until that sibling is also complete. That
 * is the ECHO-4637-class deadlock.
 *
 * Also enforces test-file naming conventions:
 *   - $TEST_INTEGRATION_COMMAND → every test file MUST be an integration
 *     test (filename `*.integration.test|spec.<ext>` OR under `integration/`).
 *   - $TEST_UNIT_COMMAND → every test file MUST NOT be an integration test.
 * Mismatches mean the test file silently lands in the wrong runner.
 *
 * @param {object} task
 * @returns {string[]} validation errors
 */
function validateTaskTestScope(task) {
  const errors = [];
  if (!task || typeof task !== 'object') return errors;

  // Skip checks for checkpoint tasks — they're explicit "verify integration"
  // markers and the implement-gate exempts them from TDD evidence entirely.
  const taskType = typeof task.type === 'string' ? task.type.toLowerCase().trim() : null;
  if (taskType === 'checkpoint' || task.isCheckpoint === true) {
    return errors;
  }

  // Rule 4b: Test Command must actually run tests. Typecheck / lint / build /
  // `true` are not behavior gates. If a task has no behavior to verify, it
  // should be merged with its consumer (SKILL.md Rule 4b).
  const nonTest = detectNonTestCommand(task.testCommand);
  if (nonTest) {
    errors.push(
      `Task ${task.num ?? '?'} \`### Test Command\` is a ${nonTest} command, not a test runner: ` +
        `${JSON.stringify(String(task.testCommand || '').slice(0, 120))}. ` +
        "A task's gate must execute tests that assert behavior. Use $TEST_UNIT_COMMAND / " +
        '$TEST_INTEGRATION_COMMAND / $TEST_E2E_COMMAND with a real test file in CHANGED_FILES. ' +
        'If this task has no testable behavior in isolation (e.g. a helper consumed only by ' +
        'another task), MERGE IT INTO THE CONSUMING TASK — see split-in-tasks SKILL.md Rule 4b.'
    );
    return errors;
  }

  // Per-eval CHANGED_FILES scoping (bug #3 fix): every `eval "$TEST_*_COMMAND"`
  // occurrence MUST be preceded by its own `CHANGED_FILES=...` assignment in
  // the same segment. A two-eval chain with only one prefix silently runs the
  // second runner against the whole repo, defeating the per-task gate.
  const evalPairs = extractEvalScopePairs(task.testCommand);
  if (evalPairs.length > 1) {
    const unscoped = evalPairs.filter((p) => p.changedFiles === null);
    if (unscoped.length > 0) {
      const carryValue = evalPairs.find((p) => p.changedFiles !== null)?.changedFiles || '<files>';
      const suggested = evalPairs
        .map((p) => `CHANGED_FILES="${p.changedFiles ?? carryValue}" eval "${p.eval}"`)
        .join(' && ');
      for (const u of unscoped) {
        errors.push(
          `Task ${task.num ?? '?'} \`### Test Command\` has an unscoped \`eval "${u.eval}"\` — ` +
            'every eval in a chained Test Command must be preceded by its own `CHANGED_FILES=...` ' +
            'assignment in the same segment, or the runner will execute the entire repo and the ' +
            'per-task gate is defeated. Corrected form: ' +
            `\`${suggested}\`.`
        );
      }
      return errors;
    }
  }

  // For downstream scope/runner-naming validation we need the UNION of every
  // eval's CHANGED_FILES, not just the first assignment. The single-pair
  // helper `extractChangedFilesFromTestCommand` is preserved for read-only
  // consumers (R8), but here we must see ALL files the chained Test Command
  // will execute against — otherwise a second eval's CHANGED_FILES escapes
  // both the scope-membership and runner-naming checks.
  const changed =
    evalPairs.length > 1
      ? Array.from(
          new Set(
            evalPairs
              .filter((p) => typeof p.changedFiles === 'string' && p.changedFiles)
              .flatMap((p) => p.changedFiles.split(/\s+/).filter(Boolean))
          )
        )
      : extractChangedFilesFromTestCommand(task.testCommand);
  // Rule 4b (helper-only): A task that uses a recognised runner but lists ZERO
  // test files in CHANGED_FILES will never have a test to execute — the gate
  // gets "No test files found" forever. This is the helper-only pattern.
  if (
    usesRecognisedRunner(task.testCommand) &&
    changed.length > 0 &&
    !changed.some((p) => TEST_FILE_EXT_RE.test(p))
  ) {
    errors.push(
      `Task ${task.num ?? '?'} \`### Test Command\` lists CHANGED_FILES with NO test files ` +
        `(no .test.* / .spec.* path). The runner will report "No test files found" and the ` +
        'gate will loop forever. This is the helper-only task pattern — the task ships code ' +
        "used by another task's tests but has no test of its own. MERGE IT INTO THE CONSUMING " +
        "TASK (split-in-tasks SKILL.md Rule 4b), or add this task's own test file to CHANGED_FILES."
    );
    return errors;
  }

  if (changed.length === 0) return errors;

  const scope =
    Array.isArray(task.filesInScope) && task.filesInScope.length > 0 ? task.filesInScope : null;
  if (scope) {
    const offenders = changed.filter((p) => !fileMatchesScope(p, scope));
    if (offenders.length > 0) {
      errors.push(
        `Task ${task.num ?? '?'} \`### Test Command\` references files not in its \`### Files in scope\`: ` +
          offenders.map((p) => `"${p}"`).join(', ') +
          '. The gate will execute the test against code owned by sibling tasks, which cannot pass until ' +
          'those siblings are also complete (deadlock). Fix by either: (a) narrowing the Test Command to a ' +
          "unit test of files this task actually ships, or (b) widening this task's Files in scope to include " +
          'the referenced files (only if this task should own them).'
      );
    }
  }

  // Test-runner / file-naming consistency.
  //
  // Multi-suite chained commands (`$TEST_UNIT_COMMAND && $TEST_INTEGRATION_COMMAND`)
  // are valid — each runner self-filters CHANGED_FILES by its include pattern.
  // We only flag a file when NO chained runner's naming convention matches it.
  const testFiles = changed.filter((p) => TEST_FILE_EXT_RE.test(p));
  if (testFiles.length > 0) {
    const runners = {
      unit: usesUnitRunner(task.testCommand),
      integration: usesIntegrationRunner(task.testCommand),
      e2e: usesE2eRunner(task.testCommand),
    };
    const fileMatchesAnyRunner = (p) => {
      if (runners.e2e && isE2eTestPath(p)) return true;
      if (runners.integration && isIntegrationTestPath(p)) return true;
      if (runners.unit && !isIntegrationTestPath(p) && !isE2eTestPath(p)) return true;
      return false;
    };
    const orphans = testFiles.filter((p) => !fileMatchesAnyRunner(p));
    if (orphans.length > 0) {
      const declared = Object.entries(runners)
        .filter(([, on]) => on)
        .map(([k]) => `$TEST_${k.toUpperCase()}_COMMAND`)
        .join(' + ');
      errors.push(
        `Task ${task.num ?? '?'} \`### Test Command\` declares ${declared || '(no known runner)'} ` +
          `but CHANGED_FILES includes test files no declared runner will pick up: ` +
          orphans.map((p) => `"${p}"`).join(', ') +
          '. Integration tests MUST match `**/*.integration.(test|spec).<ext>` OR live under ' +
          '`**/integration/**/`. E2E tests MUST match `**/*.e2e.(test|spec).<ext>` OR live under ' +
          '`**/e2e/**/`. Unit tests must do NEITHER. Either rename the test file or add the matching ' +
          'runner to the chain (e.g. append ` && eval "$TEST_INTEGRATION_COMMAND"`).'
      );
    }
  }

  return errors;
}

/**
 * GH-392 follow-up: cross-task deps must reference a path owned by another
 * task. "Cross-task" must mean cross-task — without ownership enforcement,
 * crossTaskDeps degrades into a free-form in-scope extension that bypasses
 * the Gate D scope envelope on any path the author cares to list.
 *
 * For each task T and each non-absolute entry E in T.crossTaskDeps, assert
 * that E is owned by some OTHER task — either E literally appears in that
 * task's `filesInScope`, OR E matches one of that task's scope globs
 * (delegated to `fileMatchesScope`, which handles `**` etc.).
 *
 * Absolute entries are skipped here because `validateTask` already errors
 * on them with a sharper message.
 *
 * @param {Array<object>} tasks
 * @returns {string[]} validation errors
 */
function validateCrossTaskDepsOwnership(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const errors = [];
  for (const task of tasks) {
    if (!task || !Array.isArray(task.crossTaskDeps) || task.crossTaskDeps.length === 0) continue;
    const label = `Task ${task.num ?? '?'}`;
    for (const entry of task.crossTaskDeps) {
      if (typeof entry !== 'string' || !entry) continue;
      if (_isAbsolutePathEntry(entry)) continue; // handled by validateTask
      const ownedByOther = tasks.some((other) => {
        if (!other || other.num === task.num) return false;
        const scope = Array.isArray(other.filesInScope) ? other.filesInScope : [];
        if (scope.includes(entry)) return true;
        return fileMatchesScope(entry, scope);
      });
      if (!ownedByOther) {
        errors.push(
          `${label} declares Cross-Task Dependency \`${entry}\` but no other task lists it in ` +
            "`### Files in scope`. Either add `" +
            entry +
            "` to the producing task's `### Files in scope`, or remove it from this task's " +
            '`### Cross-Task Dependencies`. (Cross-task deps must reference paths another task owns; ' +
            'they are not a free-form scope extension.)'
        );
      }
    }
  }
  return errors;
}

/**
 * Validate every task and return a flat error list.
 *
 * @param {Array<object>|null|undefined} tasks
 * @returns {{ valid:boolean, errors:string[] }}
 */
function validateAll(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { valid: false, errors: ['no tasks parsed from tasks.md'] };
  }
  const errors = [];
  for (const t of tasks) {
    errors.push(...validateTask(t));
    errors.push(...validateTaskTestScope(t));
  }
  errors.push(...validateTddCycle(tasks));
  errors.push(...validateCrossTaskDepsOwnership(tasks));
  return { valid: errors.length === 0, errors };
}

/**
 * Detect the TDD phase prefix in a task title.
 * Matches patterns like "RED: foo", "GREEN — foo", "REFACTOR - foo" at the start.
 * Returns the uppercase phase name or null.
 *
 * @param {string} title
 * @returns {string|null}
 */
function _detectPhaseInTitle(title) {
  if (typeof title !== 'string') return null;
  const m = title.match(/^\s*(RED|GREEN|REFACTOR)\s*[:\-—–]/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Extract requirement IDs from a task's `Requirements Covered` text.
 * Recognized patterns: `R1`, `R1a`, `spec §...`, `brief AC-N`, `brief P0 #N`.
 *
 * @param {string} text
 * @returns {string[]}
 */
function _extractReqIds(text) {
  if (typeof text !== 'string') return [];
  const ids = new Set();
  // R-style: R1, R1a, R12
  for (const m of text.matchAll(/\bR\d+[a-z]?\b/g)) ids.add(m[0]);
  // spec § citations: capture up to a comma, newline, or sentence end
  for (const m of text.matchAll(/spec §[^,\n]+/g)) ids.add(m[0].trim());
  // brief AC-N or brief P0/P1 #N
  for (const m of text.matchAll(/\bbrief (?:AC-\d+|P[012]\s*#\d+)\b/gi)) ids.add(m[0].trim());
  return Array.from(ids);
}

/**
 * Detect the "TDD phases split across separate tasks" anti-pattern
 * (ECHO-4453 wedge). When found, the implement-gate will be unsatisfiable
 * because Task N's RED test demands GREEN on a file owned exclusively by
 * Task N+1.
 *
 * Returns an array of human-readable error messages (empty when clean).
 *
 * @param {Array<object>} tasks - Parsed task objects from task-parser
 * @returns {string[]}
 */
function validateTddCycle(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const errors = [];
  const enriched = tasks.map((t) => ({
    num: t?.num,
    title: t?.title || '',
    type: typeof t?.type === 'string' ? t.type.toLowerCase() : '',
    phase: _detectPhaseInTitle(t?.title || ''),
    reqs: _extractReqIds(t?.requirementsCovered || ''),
  }));

  for (let i = 0; i < enriched.length; i++) {
    const cur = enriched[i];
    if (!cur.phase) continue; // Only flag phase-prefixed titles
    if (cur.type === 'checkpoint') continue;
    const next = enriched[i + 1];
    if (!next || !next.phase || next.type === 'checkpoint') continue;
    // Only flag the legitimate-looking R→G or G→R sequence
    const expected = { RED: 'GREEN', GREEN: 'REFACTOR' };
    if (expected[cur.phase] !== next.phase) continue;
    // Shared requirement coverage = strong signal both tasks describe the
    // same vertical slice across phases.
    const shared = cur.reqs.filter((r) => next.reqs.includes(r));
    if (shared.length === 0) continue;
    errors.push(
      `Task ${cur.num} (${cur.phase}) and Task ${next.num} (${next.phase}) split TDD phases across separate tasks for shared requirement(s) ${shared.join(', ')}. ` +
        `The implement-gate enforces RED→GREEN→REFACTOR within a single task; this decomposition will wedge (RED test fails, GREEN requires editing files owned by Task ${next.num}). ` +
        `Merge into one task with nested deliverables (e.g. ${cur.num}.1.1 RED, ${cur.num}.1.2 GREEN, ${cur.num}.1.3 REFACTOR). ` +
        `See skills/split-in-tasks/SKILL.md Rule 10 (ECHO-4453 wedge).`
    );
  }
  return errors;
}

/**
 * Union of `filesInScope` across the supplied tasks. Used by Gate E.
 *
 * @param {Array<object>} tasks
 * @returns {string[]}
 */
function unionFilesInScope(tasks) {
  const out = new Set();
  if (!Array.isArray(tasks)) return [];
  for (const t of tasks) {
    if (Array.isArray(t?.filesInScope)) {
      for (const p of t.filesInScope) {
        if (typeof p === 'string' && p) out.add(p);
      }
    }
  }
  return Array.from(out);
}

/**
 * Find the task with the matching task number, or null.
 *
 * @param {Array<object>} tasks
 * @param {number} taskNum
 * @returns {object|null}
 */
function findTask(tasks, taskNum) {
  if (!Array.isArray(tasks) || typeof taskNum !== 'number') return null;
  return tasks.find((t) => t && t.num === taskNum) || null;
}

module.exports = {
  validateTask,
  validateTaskTestScope,
  validateTddCycle,
  validateCrossTaskDepsOwnership,
  validateAll,
  unionFilesInScope,
  findTask,
  extractChangedFilesFromTestCommand,
  extractEvalScopePairs,
  fileMatchesScope,
  isIntegrationTestPath,
  isE2eTestPath,
  usesIntegrationRunner,
  usesUnitRunner,
  usesE2eRunner,
  usesRecognisedRunner,
  detectNonTestCommand,
  TEST_FILE_EXT_RE,
};
