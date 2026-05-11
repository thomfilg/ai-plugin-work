/**
 * Step: spec
 * Generates the technical specification from the brief and codebase analysis.
 *
 * Decision matrix:
 *   1. hasSpec=true                                        → DEFER (artifact already present)
 *   2. hasSpec=false, brief.md on disk OR hasBrief=false   → RUN with briefRef path in prompt
 *   3. hasSpec=false, brief.md NOT on disk AND hasBrief=true → RUN without briefRef
 *
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function specStep(add, s, ctx) {
  const { STEPS, t, worktreeDir, tasksDir, getDocsPrompt, fileExists, path } = ctx;
  const briefPath = path.join(tasksDir, 'brief.md');
  const specPath = path.join(tasksDir, 'spec.md');

  if (s?.hasSpec) {
    add(STEPS.spec, 'DEFER', null, 'spec.md already exists');
  } else {
    const briefRef =
      fileExists(briefPath) || !s?.hasBrief ? `\n\nRead the product brief at: ${briefPath}` : '';
    add(STEPS.spec, 'RUN', 'Task(spec-writer)', 'Generate technical specification', {
      agentType: 'spec-writer',
      agentPrompt: `Analyze the codebase in ${worktreeDir} and generate a technical specification for ticket ${t}.${briefRef}${getDocsPrompt('READ_DOCS_ON_SPEC')}\n\nSave the spec to: ${specPath}\n\nThe spec MUST include:\n1. Summary\n2. Reuse Audit (DO THIS BEFORE architecture) — Read the brief, list every UI component and data pattern needed. Find existing pages with similar features and READ their implementations to discover shared components. For EACH item, grep/glob the codebase. Decide: reuse as-is, extend, extract into shared component, or create new (with rationale)\n3. Architecture decisions (MUST reference reuse findings — new code only where reuse was explicitly rejected with rationale)\n4. Data model changes\n5. API/interface changes\n6. Security considerations\n7. Test Scenarios (Gherkin) — structured Feature/Scenario/Given/When/Then with @integration or @e2e tags (min 2 scenarios, at least 1 @integration or @e2e). Use <!-- gherkin-skip: reason --> for non-testable changes\n8. Implementation Order — numbered steps with explicit dependency notation\n9. Files to create/modify\n10. Out of Scope — explicitly list what is NOT being implemented\n11. Open Questions & Decisions — surface ambiguity with default assumptions\n12. Dependencies — external libs, services, or internal modules needed\n13. Verification Checklist — machine-checkable markers (FILE_EXISTS, GREP, TEST_COUNT, REUSES)`,
    });
  }
};
