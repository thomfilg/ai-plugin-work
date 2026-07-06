'use strict';

/**
 * workflow-def/artifact-rules.js — artifact write-protection rules for the
 * /work workflow (extracted from workflow-definition.js).
 *
 * Consumed by protect-artifact-files.js: each rule scopes writes to a step
 * (plus allowedSteps), an agent allow-list, and an optional contentGuard.
 */

const path = require('path');

/** contentGuard factory for the *.check.md report files. */
function makeReportStatusGuard(workRoot, reportType) {
  return (content) => {
    const { validateCheckReportStatus } = require(
      path.join(workRoot, '..', 'lib', 'validate-check-report-status')
    );
    const result = validateCheckReportStatus(content, reportType);
    return result.valid ? { blocked: false } : { blocked: true, message: result.message };
  };
}

/**
 * brief.md contentGuard — only enforce during the 'brief' step; brief_gate
 * is allowed to resolve questions.
 */
function makeBriefContentGuard(workRoot, STEPS) {
  return (content, currentStep) => {
    if (currentStep !== STEPS.brief) return { blocked: false };
    try {
      const openQuestions = require(path.join(workRoot, 'lib', 'open-questions'));
      const questions = openQuestions.parse(content);
      const resolvedBlocking = questions.filter(
        (q) => q.resolved && (q.scope === 'cross-ticket' || q.scope === 'architectural')
      );
      if (resolvedBlocking.length > 0) {
        return {
          blocked: true,
          message:
            `BLOCKED: Cannot resolve blocking open questions during the brief step.\n` +
            `Found ${resolvedBlocking.length} resolved architectural/cross-ticket question(s).\n` +
            `Only the brief_gate step (via AskUserQuestion) can resolve blocking questions.\n` +
            `Write the questions with resolved: false and let the brief_gate handle resolution.\n`,
        };
      }
    } catch {
      // fail-open on parse errors
    }
    return { blocked: false };
  };
}

/** tasks.md contentGuard — task-description quality policy (fail-open). */
function makeTasksContentGuard(workRoot) {
  return (content) => {
    try {
      const { validateTaskDescriptions } = require(
        path.join(workRoot, '..', 'lib', 'hooks', 'policies', 'task-description-quality')
      );
      const result = validateTaskDescriptions(content);
      return result.blocked ? { blocked: true, message: result.message } : { blocked: false };
    } catch {
      return { blocked: false }; // fail-open
    }
  };
}

function buildArtifactRules({ STEPS, workRoot }) {
  return [
    {
      basename: 'brief.md',
      step: STEPS.brief,
      // brief_gate may amend brief.md to record `## Sibling-gap decisions`
      // and to resolve open-questions. Without this allowedSteps entry,
      // brief_gate edits get blocked by the artifact-protector before the
      // contentGuard below ever runs.
      allowedSteps: [STEPS.brief_gate],
      agents: ['brief-writer'],
      contentGuard: makeBriefContentGuard(workRoot, STEPS),
    },
    {
      basename: 'spec.md',
      step: STEPS.spec,
      // spec_gate may need in-place edits when its validators (brief↔spec
      // coverage, embedded gherkin) fail. Without this, the agent can't
      // repair the spec without manual state-machine rewinding.
      allowedSteps: [STEPS.spec_gate],
      agents: ['spec-writer'],
    },
    {
      basename: 'tasks.md',
      step: STEPS.tasks,
      // Gate C runs at tasks_gate; in-place repair must be possible there
      // without widening implement-step authority (which would let agents
      // grant themselves broader Gate D file scope mid-implementation).
      allowedSteps: [STEPS.tasks_gate, STEPS.task_review],
      agents: [],
      contentGuard: makeTasksContentGuard(workRoot),
    },
    { basename: '.last-commit-sha', step: STEPS.commit },
    {
      basename: 'code-review.check.md',
      step: STEPS.check,
      agents: ['code-checker'],
      contentGuard: makeReportStatusGuard(workRoot, 'codeReview'),
    },
    {
      basename: 'tests.check.md',
      step: STEPS.check,
      agents: ['quality-checker'],
      contentGuard: makeReportStatusGuard(workRoot, 'tests'),
    },
    {
      basename: 'completion.check.md',
      step: STEPS.check,
      agents: ['completion-checker'],
      contentGuard: makeReportStatusGuard(workRoot, 'completion'),
    },
    {
      pattern: /^qa-.*\.check\.md$/,
      step: STEPS.check,
      agents: ['qa-feature-tester', 'qa-api-tester'],
    },
    {
      basename: 'code-review-reply.check.md',
      step: STEPS.check,
      agents: ['developer-nodejs-tdd', 'developer-react-senior', 'developer-devops'],
    },
    { basename: 'review-accountability.json', step: STEPS.follow_up, agents: ['follow-up-pr'] },
  ];
}

module.exports = { buildArtifactRules };
