/**
 * Kind: e2e — Playwright / journey tests.
 *
 * Validates:
 *   1. spec.md lists at least one `tests/e2e/**\/*.spec.(ts|tsx)` file in Files to Create/Modify.
 *   2. gherkin.feature exists and tags at least one scenario `@e2e`.
 *   3. spec.md mentions journey/page-object reuse (warning only).
 *   4. **Selector audit (ECHO-4457 lesson)** — spec.md must include a
 *      `## Selectors` section that enumerates every UI selector the E2E
 *      will touch with one of two shapes:
 *        - `- \`<selector>\` — existing — \`<file>\``
 *        - `- \`<selector>\` — new — \`<file-to-create>\``
 *      For "existing" entries, grep the cited file for the selector
 *      literal and block on miss (this is the bug class where ECHO-4457's
 *      planned spec testids didn't match shipped sibling components).
 *      For "new" entries, the cited file must appear in spec's
 *      `## Files to Create/Modify` so the new selector is in-scope.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  readSpec,
  filesInFilesToModify,
  isE2eFile,
  sliceSection,
  detectKinds,
} = require('./shared');

function appliesTo(ctx) {
  return detectKinds(ctx.tasksDir).includes('e2e');
}

function readGherkin(tasksDir) {
  try {
    return fs.readFileSync(path.join(tasksDir, 'gherkin.feature'), 'utf8');
  } catch {
    return '';
  }
}

function resolveWorktreeRoot(ctx) {
  if (ctx.worktreeRoot && typeof ctx.worktreeRoot === 'string') return ctx.worktreeRoot;
  // Fall back: tasksDir is typically <worktree>/tasks/<TICKET>
  return path.resolve(ctx.tasksDir, '..', '..');
}

function parseSelectorLines(block) {
  if (!block) return [];
  const out = [];
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('-') && !line.startsWith('*')) continue;
    // Match `<sel>` — existing|new — `<file>`
    const m = line.match(/`([^`]+)`\s*[—\-]\s*(existing|new)\s*[—\-]\s*`([^`]+)`/i);
    if (m) {
      out.push({ selector: m[1].trim(), kind: m[2].toLowerCase(), file: m[3].trim() });
    } else if (/`[^`]+`/.test(line)) {
      out.push({ malformed: true, raw: line });
    }
  }
  return out;
}

function selectorPresent(content, selector) {
  if (!content) return false;
  // Match: data-testid="X", data-testid='X', data-testid={'X'}, data-testid={`X`}
  // Or the raw selector token if it's a longer aria-name/role pattern (literal match).
  const literal = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    new RegExp(`data-testid\\s*=\\s*[{]?\\s*['"\`]${literal}['"\`]`).test(content) ||
    content.includes(selector)
  );
}

function validate(ctx) {
  const spec = readSpec(ctx.tasksDir);
  const files = filesInFilesToModify(spec);
  const errors = [];
  const warnings = [];

  if (!files.some(isE2eFile)) {
    errors.push(
      'e2e kind but no `tests/e2e/**/*.spec.(ts|tsx)` file listed in `## Files to Create/Modify`.'
    );
  }

  const gherkin = readGherkin(ctx.tasksDir);
  if (gherkin && !/@e2e\b/.test(gherkin)) {
    errors.push('e2e kind but `gherkin.feature` has no scenario tagged `@e2e`.');
  } else if (!gherkin) {
    warnings.push(
      'No gherkin.feature file present — Gherkin coverage will be checked by spec_gate separately.'
    );
  }

  if (!/journey|page[-\s]?object/i.test(spec)) {
    warnings.push(
      'spec.md does not mention "journey" or "page object" — confirm reusable helpers are used.'
    );
  }

  // ── Selector audit ──────────────────────────────────────────────────────
  const selectorBlock = sliceSection(spec, /^##\s+Selectors?\b/im);
  if (!selectorBlock.trim()) {
    errors.push(
      'e2e kind requires a `## Selectors` section in spec.md enumerating every selector ' +
        'the test will use. Format per line: `` `selector-name` — existing — `path/to/file.tsx` `` ' +
        '(or `new` if this ticket creates the component). Look on siblings tickets for existing selectors and use them if they exist. ' +
        'If no existing selectors are found, create a new selector.'
    );
  } else {
    const entries = parseSelectorLines(selectorBlock);
    if (entries.length === 0) {
      errors.push(
        '`## Selectors` section is empty or no entries matched the required format ' +
          '(`` `selector` — existing|new — `file` ``).'
      );
    }
    const worktreeRoot = resolveWorktreeRoot(ctx);
    const filesToModify = new Set(files);
    for (const entry of entries) {
      if (entry.malformed) {
        warnings.push(`Selector line not in canonical format: ${entry.raw}`);
        continue;
      }
      if (entry.kind === 'existing') {
        const filePath = path.resolve(worktreeRoot, entry.file);
        let content;
        try {
          content = fs.readFileSync(filePath, 'utf8');
        } catch {
          errors.push(
            `Selector \`${entry.selector}\` declared as existing in \`${entry.file}\` but the file does not exist.`
          );
          continue;
        }
        if (!selectorPresent(content, entry.selector)) {
          errors.push(
            `Selector \`${entry.selector}\` declared as existing in \`${entry.file}\` but not found there ` +
              '(grep miss). Either the selector name is wrong, or the file changed since spec was drafted.'
          );
        }
      } else if (entry.kind === 'new') {
        if (!filesToModify.has(entry.file)) {
          errors.push(
            `Selector \`${entry.selector}\` declared as new in \`${entry.file}\` but that file is NOT in ` +
              "`## Files to Create/Modify`. New selectors require an owning file in this PR's scope."
          );
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `${files.filter(isE2eFile).length} e2e file(s) listed`,
  };
}

module.exports = function register(registerKind) {
  registerKind('e2e', { appliesTo, validate });
};

module.exports.appliesTo = appliesTo;
module.exports.validate = validate;
module.exports.parseSelectorLines = parseSelectorLines;
module.exports.selectorPresent = selectorPresent;
