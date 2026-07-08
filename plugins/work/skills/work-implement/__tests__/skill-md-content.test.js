const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_PATH = path.resolve(__dirname, '..', 'SKILL.md');
const content = fs.readFileSync(SKILL_PATH, 'utf-8');

/**
 * Extract the orchestrator-mode section from Step 5.
 * Starts at "When called from `/work` orchestrator" and ends at the next
 * bold-prefixed mode header ("**When in ").
 */
function getOrchestratorSection() {
  const start = content.search(/\*\*When called from [`/]*(?:\/)?work[`]* orchestrator/);
  if (start === -1) return null;
  const rest = content.slice(start);
  const nextHeader = rest.slice(1).search(/\n\*\*When in /);
  if (nextHeader === -1) return rest;
  return rest.slice(0, nextHeader + 1);
}

/**
 * Extract the normal-mode section from Step 5.
 */
function getNormalModeSection() {
  const start = content.search(/\*\*When in normal mode/);
  if (start === -1) return null;
  const rest = content.slice(start);
  const nextHeader = rest.slice(1).search(/\n##[^#]/);
  if (nextHeader === -1) return rest;
  return rest.slice(0, nextHeader + 1);
}

/**
 * Extract the subtask-mode section from Step 5.
 */
function getSubtaskModeSection() {
  const start = content.search(/\*\*When in subtask mode/);
  if (start === -1) return null;
  const rest = content.slice(start);
  const nextHeader = rest.slice(1).search(/\n\*\*When /);
  if (nextHeader === -1) return rest;
  return rest.slice(0, nextHeader + 1);
}

/**
 * Extract the Notes section (from ## Notes to end of file).
 */
function getNotesSection() {
  const idx = content.search(/^## Notes/m);
  if (idx === -1) return null;
  return content.slice(idx);
}

describe('work-implement SKILL.md — orchestrator completion (GH-231)', () => {
  describe('Scenario 1: orchestrator section contains no structured signal block', () => {
    it('the orchestrator-mode section exists', () => {
      const section = getOrchestratorSection();
      assert.ok(section, 'SKILL.md must contain a "When called from /work orchestrator" section');
    });

    it('the orchestrator section does NOT contain "IMPLEMENT_COMPLETE" text', () => {
      const section = getOrchestratorSection();
      assert.ok(section, 'orchestrator section must exist');
      assert.doesNotMatch(
        section,
        /IMPLEMENT_COMPLETE/,
        'Orchestrator section must NOT contain "IMPLEMENT_COMPLETE" — use prose instructions instead'
      );
    });

    it('the orchestrator section contains prose instructing the agent to finish and return control', () => {
      const section = getOrchestratorSection();
      assert.ok(section, 'orchestrator section must exist');
      assert.match(
        section,
        /return.*control|hand.*control.*back|return.*orchestrator/i,
        'Orchestrator section must contain prose about returning control to the orchestrator'
      );
    });

    it('the orchestrator section does NOT contain a fenced code block with a signal format', () => {
      const section = getOrchestratorSection();
      assert.ok(section, 'orchestrator section must exist');
      assert.ok(
        !section.includes('```'),
        'Orchestrator section must NOT contain any fenced code blocks (triple backticks)'
      );
    });
  });

  describe('Scenario 2: standalone mode completion instructions are preserved', () => {
    it('the normal-mode section exists', () => {
      const section = getNormalModeSection();
      assert.ok(section, 'SKILL.md must contain a "When in normal mode" section');
    });

    it('contains "Implementation Complete"', () => {
      const section = getNormalModeSection();
      assert.ok(section, 'normal-mode section must exist');
      assert.match(
        section,
        /Implementation Complete/,
        'Normal-mode section must contain "Implementation Complete"'
      );
    });

    it('contains "Next steps"', () => {
      const section = getNormalModeSection();
      assert.ok(section, 'normal-mode section must exist');
      assert.match(section, /Next steps/, 'Normal-mode section must contain "Next steps"');
    });
  });

  describe('Scenario 3: subtask mode completion instructions are preserved', () => {
    it('the subtask-mode section exists', () => {
      const section = getSubtaskModeSection();
      assert.ok(section, 'SKILL.md must contain a "When in subtask mode" section');
    });

    it('instructs the agent to commit changes', () => {
      const section = getSubtaskModeSection();
      assert.ok(section, 'subtask-mode section must exist');
      assert.match(section, /[Cc]ommit/, 'Subtask-mode section must instruct committing changes');
    });

    it('instructs the agent to mark the subtask as completed', () => {
      const section = getSubtaskModeSection();
      assert.ok(section, 'subtask-mode section must exist');
      assert.match(
        section,
        /complete[d\-]?.*subtask|mark.*subtask.*complete|subtask.*complet/i,
        'Subtask-mode section must instruct marking the subtask as completed'
      );
    });

    it('instructs the agent to return control to the parent workflow', () => {
      const section = getSubtaskModeSection();
      assert.ok(section, 'subtask-mode section must exist');
      assert.match(
        section,
        /return.*control|parent.*workflow/i,
        'Subtask-mode section must instruct returning control to the parent workflow'
      );
    });
  });

  describe('Scenario 4: orchestrator-mode section still requires updating implement.md', () => {
    it('the orchestrator section instructs updating implement.md with results', () => {
      const section = getOrchestratorSection();
      assert.ok(section, 'orchestrator section must exist');
      assert.match(
        section,
        /implement\.md/,
        'Orchestrator section must reference updating implement.md'
      );
    });

    it('the implement.md instruction appears before the return-control instruction', () => {
      const section = getOrchestratorSection();
      assert.ok(section, 'orchestrator section must exist');
      const implementIdx = section.search(/implement\.md/);
      const returnIdx = section.search(/return.*control|hand.*control.*back|return.*orchestrator/i);
      assert.ok(implementIdx > -1, 'implement.md reference must exist');
      assert.ok(returnIdx > -1, 'return-control instruction must exist');
      assert.ok(
        implementIdx < returnIdx,
        'implement.md instruction must appear before the return-control instruction'
      );
    });
  });

  describe('Scenario 5: Notes section orchestrator-mode bullet', () => {
    it('the Notes section has an orchestrator-mode bullet', () => {
      const section = getNotesSection();
      assert.ok(section, 'Notes section must exist');
      assert.match(
        section,
        /[Oo]rchestrator/,
        'Notes section must have an orchestrator-mode bullet'
      );
    });

    it('the orchestrator-mode bullet does NOT reference "completion signal" or "structured block"', () => {
      const section = getNotesSection();
      assert.ok(section, 'Notes section must exist');
      const lines = section.split('\n');
      const orchestratorLines = lines.filter((l) => /[Oo]rchestrator/.test(l));
      assert.ok(orchestratorLines.length > 0, 'Must have orchestrator line in Notes');
      for (const line of orchestratorLines) {
        assert.doesNotMatch(
          line,
          /completion signal/i,
          'Orchestrator bullet in Notes must NOT reference "completion signal"'
        );
        assert.doesNotMatch(
          line,
          /structured block/i,
          'Orchestrator bullet in Notes must NOT reference "structured block"'
        );
      }
    });
  });
});

describe('work-implement SKILL.md — current TDD flow pins (W10, implement-phase fix design)', () => {
  it('Step 2.5 teaches task-next.js as the single entrypoint when tasks.md exists', () => {
    assert.match(
      content,
      /task-next\.js.*<TICKET_ID> task<N>/,
      'Step 2.5 must show the task-next.js invocation shape'
    );
    assert.match(
      content,
      /single entrypoint/i,
      'Step 2.5 must state task-next.js is the single entrypoint in multi-task mode'
    );
  });

  it('Step 2.5 documents Test Strategy synthesis instead of a manual command', () => {
    assert.match(content, /### Test Strategy/, 'must reference the ### Test Strategy block');
    assert.match(
      content,
      /do NOT pass any test command/i,
      'must tell the agent not to hand-pick a test command in multi-task mode'
    );
  });

  it('Step 2.5 documents citation kinds and the machine-verified resume path', () => {
    assert.match(content, /verified-by/, 'must mention the verified-by citation kind');
    assert.match(content, /wiring-citation/, 'must mention the wiring-citation kind');
    assert.match(content, /--resume-completed/, 'must mention the machine-verified resume flag');
    assert.match(content, /tdd-resume-completed/, 'must name the resume audit row');
  });

  it('references the actually-registered enforcement hooks (W1 wiring)', () => {
    assert.match(content, /work-implement-enforce\.js/, 'must name the phase file-gating hook');
    assert.match(content, /enforce-tdd-on-stop\.js/, 'must name the stop-gating hook');
    assert.match(content, /SubagentStop/, 'must name the SubagentStop event the stop hook uses');
    assert.match(
      content,
      /Edit\|Write\|MultiEdit/,
      'must name the PreToolUse matcher for the phase-gating hook'
    );
  });

  it('describes exception mode as operator-only (no agent-facing exception flow)', () => {
    assert.match(content, /operator-only/i, 'exception mode must be described as operator-only');
    assert.match(
      content,
      /WORK_OPERATOR_TOKEN=1/,
      'must name the operator token gate for the exception subcommand'
    );
    assert.doesNotMatch(
      content,
      /Allowed categories: `checkpoint`, `config-only`/,
      'the stale agent-facing exception category list must be gone'
    );
  });

  it('lists the full TDD-exempt Type enum from task-types.js (W2 taxonomy)', () => {
    const { TDD_EXEMPT_TYPES } = require('../../split-in-tasks/lib/task-types');
    for (const type of TDD_EXEMPT_TYPES) {
      assert.ok(content.includes(`\`${type}\``), `SKILL.md must list TDD-exempt type \`${type}\``);
    }
  });

  it('never instructs the agent to edit tasks.md (W3 message policy)', () => {
    const forbidden = [
      new RegExp(`${'update'} tasks\\.md`, 'i'),
      new RegExp(`${'fix'} tasks\\.md`, 'i'),
      new RegExp(`(?<!not\\s)(?<!never\\s)(?<!never to\\s)${'edit'} tasks\\.md`, 'i'),
    ];
    for (const re of forbidden) {
      assert.doesNotMatch(content, re, `SKILL.md must not match forbidden phrasing ${re}`);
    }
    assert.match(
      content,
      /BLOCKED \(planner-defect\)/,
      'SKILL.md must teach the BLOCKED (planner-defect) report convention instead'
    );
  });
});
