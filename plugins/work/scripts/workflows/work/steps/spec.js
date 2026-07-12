/**
 * Step: spec
 * Generates the technical specification from the brief and codebase analysis.
 *
 * Decision matrix:
 *   1. ledger unparseable                                  → RUN AskUserQuestion
 *      escalation (GH-696/PR #718: a corrupt spec-phase.json cannot be
 *      repaired by re-dispatching the writer)
 *   2. hasSpec=true, ledger terminal/absent               → DEFER (artifact already present)
 *   3. hasSpec=true, ledger mid-flight                    → RUN  (GH-696: re-dispatch the
 *      spec-writer — spec-next.js resumes from the recorded phase)
 *   4. hasSpec=false, brief.md on disk OR hasBrief=false   → RUN with briefRef path in prompt
 *   5. hasSpec=false, brief.md NOT on disk AND hasBrief=true → RUN without briefRef
 */

'use strict';

const { UNPARSEABLE_PHASE } = require('../lib/phase-ledger');
const { addUnparseableLedgerEscalation } = require('./lib/unparseable-ledger-escalation');

/** Decision 3: spec.md exists but the ledger is mid-flight — resume the runner. */
function addSpecResumeRun(add, s, ctx, specPath) {
  const { STEPS, t, getDocsPrompt } = ctx;
  add(
    STEPS.spec,
    'RUN',
    'Task(spec-writer)',
    `spec.md exists but spec-phase.json is mid-flight at "${s.specPhase}" — resume the spec runner`,
    {
      agentType: 'spec-writer',
      agentPrompt: `Resume the technical specification for ticket ${t}: spec.md exists at ${specPath} but the inner phase ledger spec-phase.json is at "${s.specPhase}" (not "done").\n\n**Run \`node $CLAUDE_PLUGIN_ROOT/scripts/workflows/work-spec/spec-next.js ${t}\` and follow its instructions** — it resumes from the recorded phase and drives the remaining phases (… → validate → memorize → kind_checks → done). Do NOT edit spec-phase.json directly.${getDocsPrompt('READ_DOCS_ON_SPEC')}`,
    }
  );
}

/** Decisions 4-5: generate the spec (briefRef included when brief.md is readable). */
function addSpecGenerateRun(add, s, ctx, briefPath, specPath) {
  const { STEPS, t, worktreeDir, getDocsPrompt, fileExists } = ctx;
  const briefRef =
    fileExists(briefPath) || !s?.hasBrief ? `\n\nRead the product brief at: ${briefPath}` : '';
  add(STEPS.spec, 'RUN', 'Task(spec-writer)', 'Generate technical specification', {
    agentType: 'spec-writer',
    agentPrompt: `Analyze the codebase in ${worktreeDir} and generate a technical specification for ticket ${t}.${briefRef}${getDocsPrompt('READ_DOCS_ON_SPEC')}\n\nSave the spec to: ${specPath}\n\n**Run \`node $CLAUDE_PLUGIN_ROOT/scripts/workflows/work-spec/spec-next.js ${t}\` at each step.** It is the authoritative phase driver — it tells you what to do for the current phase (inputs → reuse_audit → surface_audit → draft → validate → memorize → kind_checks → done) and records/transitions the phase state when each check passes. Do NOT edit \`spec-phase.json\` directly.\n\nThe spec MUST include (these are the sections the \`draft\` phase will gate on):\n1. Summary\n2. Reuse Audit\n3. Architecture Decisions\n4. Data Model Changes\n5. API/Interface Changes\n6. Security Considerations\n7. Test Scenarios (Gherkin) — structured Feature/Scenario/Given/When/Then with @integration or @e2e tags (min 2 scenarios). Use <!-- gherkin-skip: reason --> for non-testable changes\n8. Implementation Order — numbered steps with explicit dependency notation\n9. Files to Create/Modify\n10. Out of Scope\n11. Open Questions & Decisions\n12. Dependencies\n13. Verification Checklist — machine-checkable markers (FILE_EXISTS, GREP, TEST_COUNT, REUSES)\n\nThe \`surface_audit\` phase will record a \`## Verified sibling surface\` block; the \`kind_checks\` phase will record a \`## Kind verification\` block — both are automatic.`,
  });
}

/**
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function specStep(add, s, ctx) {
  const { STEPS, tasksDir, path } = ctx;
  const briefPath = path.join(tasksDir, 'brief.md');
  const specPath = path.join(tasksDir, 'spec.md');

  if (s?.specPhaseMidFlight && s.specPhase === UNPARSEABLE_PHASE) {
    addUnparseableLedgerEscalation(add, ctx, {
      step: STEPS.spec,
      ledgerFile: 'spec-phase.json',
      artifact: 'spec.md',
    });
    return;
  }
  if (s?.hasSpec && !s.specPhaseMidFlight) {
    add(STEPS.spec, 'DEFER', null, 'spec.md already exists');
    return;
  }
  if (s?.hasSpec) {
    addSpecResumeRun(add, s, ctx, specPath);
    return;
  }
  addSpecGenerateRun(add, s, ctx, briefPath, specPath);
};
