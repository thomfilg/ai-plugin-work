/**
 * Spec-gate step enrichment.
 *
 * When spec_gate is RUN (gherkin validation failed), reads the spec.md,
 * runs gherkin parse/validate, and shows the specific errors so the AI
 * knows what to fix instead of blindly re-running /spec.
 */

'use strict';

const {
  extractP0Ids,
  checkP0Coverage,
  checkSiblingOosRestatement,
} = require('../../../lib/brief-spec-coverage');

function _readFile(filePath, fs) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function buildBriefSpecCoverageBlocker(missingIds, oosCheck, briefPath, specPath) {
  const lines = [];
  if (missingIds.length > 0) {
    lines.push(`P0 IDs from ${briefPath} not referenced in ${specPath}:`);
    for (const id of missingIds) lines.push(`  - P0 #${id}`);
  }
  if (oosCheck && !oosCheck.ok) {
    lines.push('');
    lines.push(`OOS restatement: ${oosCheck.reason}`);
    if (Array.isArray(oosCheck.missingEntries)) {
      lines.push('Missing entries in spec:');
      for (const e of oosCheck.missingEntries) lines.push(`  - ${e}`);
    }
  }
  return {
    type: 'work_instruction',
    action: 'blocked',
    reason: 'spec_gate: brief↔spec coverage failed (Gate B)',
    details: lines.join('\n'),
    hint: 'Edit spec.md so every brief P0 is referenced (heading or inline `P0 #N`) and the `## Out of scope (sibling-owned)` section is restated verbatim. Re-run /work2.',
  };
}

function _runBriefSpecCoverage(entry, ctx) {
  const { tasksDir, path, fs } = ctx;
  const briefPath = path.join(tasksDir, 'brief.md');
  const specPath = path.join(tasksDir, 'spec.md');
  const briefText = _readFile(briefPath, fs);
  const specText = _readFile(specPath, fs);
  if (!briefText || !specText) return; // skip when either is missing

  const ids = extractP0Ids(briefText);
  const { missing } = checkP0Coverage(specText, ids);
  const oos = checkSiblingOosRestatement(briefText, specText);
  if (missing.length === 0 && oos.ok) return;

  entry._overrideInstruction = buildBriefSpecCoverageBlocker(missing, oos, briefPath, specPath);
}

module.exports = function registerSpecGate(register) {
  // Gate B — brief↔spec coverage; runs BEFORE the gherkin-validation logic
  // below so coverage failures block the same way as gherkin failures.
  register('spec_gate', (entry, ctx) => {
    if (entry._overrideInstruction) return;
    _runBriefSpecCoverage(entry, ctx);
  });

  register('spec_gate', (entry, ctx) => {
    if (entry._overrideInstruction) return;
    const { tasksDir, workDir, path, fs } = ctx;
    const specPath = path.join(tasksDir, 'spec.md');

    if (!fs.existsSync(specPath)) {
      entry.agentPrompt = 'spec.md does not exist. Run /spec to generate it.';
      return;
    }

    // Run gherkin validation to get specific errors
    let errors = [];
    let hasSkip = false;
    try {
      const parseGherkin = require(path.join(workDir, 'lib', 'parse-gherkin'));
      const markdown = fs.readFileSync(specPath, 'utf8');

      const skipResult = parseGherkin.hasSkipOverride(markdown);
      if (skipResult.skip) {
        hasSkip = true;
      } else {
        const parsed = parseGherkin.parse(markdown);
        const validation = parseGherkin.validate(parsed);
        if (parsed.errors && parsed.errors.length > 0) {
          errors.push(...parsed.errors.map((e) => `Parse error: ${e}`));
        }
        if (!validation.valid && validation.errors) {
          errors.push(...validation.errors.map((e) => `Validation: ${e}`));
        }
        if (!validation.valid && validation.issues) {
          errors.push(...validation.issues.map((e) => `Issue: ${e}`));
        }
      }
    } catch (err) {
      errors.push(`Gherkin module error: ${err.message}`);
    }

    if (hasSkip || errors.length === 0) {
      // Gate should pass — this shouldn't happen but handle gracefully
      entry.agentPrompt = 'spec_gate should pass. Re-run work-next.js to advance.';
      return;
    }

    // Build detailed instruction with specific errors
    const lines = [
      '## spec_gate: Fix Gherkin Validation Errors\n',
      `Spec file: ${specPath}`,
      `Errors found: ${errors.length}\n`,
      '### Validation Errors\n',
    ];
    errors.forEach((e, i) => {
      lines.push(`${i + 1}. ${e}`);
    });
    lines.push('');
    lines.push('### What to do\n');
    const gherkinPath = path.join(tasksDir, 'gherkin.feature');
    lines.push(`Edit \`${gherkinPath}\` (the standalone file the validator reads) to fix:`);
    lines.push('- Missing Feature/Scenario/Given/When/Then structure');
    lines.push('- Missing or invalid tags — ONLY `@integration` and `@e2e` are valid');
    lines.push('  - `@unit`, `@storybook`, `@smoke`, etc. WILL fail validation');
    lines.push('- Fewer than 2 scenarios');
    lines.push('');
    lines.push('Also keep `spec.md` consistent if it embeds gherkin inline.');
    lines.push('');
    lines.push(
      `If this change is non-testable, add \`<!-- gherkin-skip: reason -->\` to spec.md instead.`
    );
    lines.push('');
    lines.push(
      'IMPORTANT: Edit gherkin.feature in-place — do NOT regenerate the entire spec. `protect-gherkin.js` allows writes during spec_gate when validation is failing.'
    );

    entry.agentPrompt = lines.join('\n');
    // Override agentType to general-purpose (no need for spec-writer skill, just edit)
    entry.agentType = 'general-purpose';
  });
};
