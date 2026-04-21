/**
 * Step: spec
 * Generates the technical specification from the brief and codebase analysis.
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function specStep(add, s, ctx) {
  const { STEPS, t, worktreeDir, tasksDir, getDocsPrompt, fileExists, path } = ctx;
  const specEnabled = process.env.WORK_SPEC_ENABLED !== '0';
  const briefEnabled = process.env.WORK_BRIEF_ENABLED !== '0';
  const briefPath = path.join(tasksDir, 'brief.md');
  const specPath = path.join(tasksDir, 'spec.md');

  if (!specEnabled) {
    add(STEPS.spec, 'DEFER', null, 'Spec generation disabled (WORK_SPEC_ENABLED=0)');
  } else if (s?.hasSpec) {
    add(STEPS.spec, 'DEFER', null, 'spec.md already exists');
  } else {
    const briefRef =
      fileExists(briefPath) || (briefEnabled && !s?.hasBrief)
        ? `\n\nRead the product brief at: ${briefPath}`
        : '';
    add(STEPS.spec, 'RUN', 'Task(spec-writer)', 'Generate technical specification', {
      agentType: 'spec-writer',
      agentPrompt: `Analyze the codebase in ${worktreeDir} and generate a technical specification for ticket ${t}.${briefRef}\n\nSave the spec to: ${specPath}\n\nThe spec MUST include:\n1. Summary\n2. Architecture decisions (reference specific files)\n3. Data model changes\n4. API/interface changes\n5. Security considerations\n6. Test Scenarios (Gherkin) — structured Feature/Scenario/Given/When/Then with @integration or @e2e tags (min 2 scenarios, at least 1 @integration or @e2e). Use <!-- gherkin-skip: reason --> for non-testable changes\n7. Reuse Audit — grep/glob for existing patterns, components, utilities that can be reused\n8. Implementation Order — numbered steps with explicit dependency notation\n9. Files to create/modify\n10. Out of Scope — explicitly list what is NOT being implemented\n11. Open Questions & Decisions — surface ambiguity with default assumptions\n12. Dependencies — external libs, services, or internal modules needed\n13. Verification Checklist — machine-checkable markers (FILE_EXISTS, GREP, TEST_COUNT, REUSES)${getDocsPrompt('READ_DOCS_ON_SPEC')}`,
    });
  }
};
