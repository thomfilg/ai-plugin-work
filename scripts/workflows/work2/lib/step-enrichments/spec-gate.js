/**
 * Spec-gate step enrichment.
 *
 * When spec_gate is RUN (gherkin validation failed), reads the spec.md,
 * runs gherkin parse/validate, and shows the specific errors so the AI
 * knows what to fix instead of blindly re-running /spec.
 */

'use strict';

module.exports = function registerSpecGate(register) {
  register('spec_gate', (entry, ctx) => {
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
    lines.push('Edit spec.md to fix the gherkin section. Common issues:');
    lines.push('- Missing Feature/Scenario/Given/When/Then structure');
    lines.push('- Missing @integration or @e2e tags');
    lines.push('- Less than 2 scenarios');
    lines.push('- Gherkin not inside a ```gherkin code fence');
    lines.push('');
    lines.push(
      `If this change is non-testable, add \`<!-- gherkin-skip: reason -->\` to spec.md instead.`
    );
    lines.push('');
    lines.push(
      'IMPORTANT: Edit spec.md directly to fix the gherkin. Do NOT regenerate the entire spec.'
    );

    entry.agentPrompt = lines.join('\n');
    // Override agentType to general-purpose (no need for spec-writer skill, just edit)
    entry.agentType = 'general-purpose';
  });
};
