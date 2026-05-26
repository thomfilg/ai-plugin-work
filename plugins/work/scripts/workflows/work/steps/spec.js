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
      agentPrompt: `Analyze the codebase in ${worktreeDir} and generate a technical specification for ticket ${t}.${briefRef}${getDocsPrompt('READ_DOCS_ON_SPEC')}\n\nSave the spec to: ${specPath}\n\n**Run \`node $CLAUDE_PLUGIN_ROOT/scripts/workflows/work-spec/spec-next.js ${t}\` at each step.** It is the authoritative phase driver — it tells you what to do for the current phase (inputs → reuse_audit → surface_audit → draft → validate → memorize → kind_checks → done) and records/transitions the phase state when each check passes. Do NOT edit \`spec-phase.json\` directly.\n\nThe spec MUST include (these are the sections the \`draft\` phase will gate on):\n1. Summary\n2. Reuse Audit\n3. Architecture Decisions\n4. Data Model Changes\n5. API/Interface Changes\n6. Security Considerations\n7. Test Scenarios (Gherkin) — structured Feature/Scenario/Given/When/Then with @integration or @e2e tags (min 2 scenarios). Use <!-- gherkin-skip: reason --> for non-testable changes\n8. Implementation Order — numbered steps with explicit dependency notation\n9. Files to Create/Modify\n10. Out of Scope\n11. Open Questions & Decisions\n12. Dependencies\n13. Verification Checklist — machine-checkable markers (FILE_EXISTS, GREP, TEST_COUNT, REUSES)\n\nThe \`surface_audit\` phase will record a \`## Verified sibling surface\` block; the \`kind_checks\` phase will record a \`## Kind verification\` block — both are automatic.`,
    });
  }
};
