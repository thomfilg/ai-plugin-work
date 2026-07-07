'use strict';

/**
 * Dual-runtime tests for the two shared write-protector factories (WP-07/C6):
 * createFileProtector (protect-state-files.js) and createArtifactProtector
 * (protect-artifact-files.js).
 *
 * On codex the Edit|Write matcher lanes alias-fire for `apply_patch`, whose
 * payload is a raw patch (`*** Begin Patch … *** End Patch`) with NO
 * file_path field. Both factories parse the patch headers into write targets
 * and run every target through the same protection rules. Unparseable
 * patches fail OPEN here — these are advisory workflow protectors, not the
 * heimdall security boundary.
 *
 * Claude events (Edit/Write/MultiEdit/Bash) are characterization-locked by
 * the existing protect-state-files.test.js / protect-artifact-files.test.js
 * suites; this file adds the apply_patch lane.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createFileProtector, basenameProtector } = require(
  path.join(__dirname, '..', 'protect-state-files')
);
const { createArtifactProtector } = require(path.join(__dirname, '..', 'protect-artifact-files'));

function patch(headers) {
  return `*** Begin Patch\n${headers.join('\n')}\n+content line\n*** End Patch\n`;
}

describe('createFileProtector — apply_patch vector', () => {
  const protector = createFileProtector({
    isProtected: basenameProtector(new Set(['.work-state.json', 'tdd-phase.json'])),
  });

  it('blocks an apply_patch whose header targets a protected basename', () => {
    const result = protector.check(
      'apply_patch',
      { command: patch(['*** Update File: tasks/GH-1/.work-state.json']) },
      { cwd: '/tmp' }
    );
    assert.equal(result.blocked, true);
    assert.equal(result.match, '.work-state.json');
    assert.equal(result.vector, 'apply_patch');
    assert.equal(result.skipRemainingChecks, true);
    assert.match(result.message, /apply_patch/);
  });

  it('blocks when ANY target of a multi-file patch is protected', () => {
    const result = protector.check(
      'apply_patch',
      {
        command: patch(['*** Add File: src/ok.js', '*** Update File: task3/tdd-phase.json']),
      },
      { cwd: '/tmp' }
    );
    assert.equal(result.blocked, true);
    assert.equal(result.match, 'tdd-phase.json');
  });

  it('allows an apply_patch touching only unprotected files', () => {
    const result = protector.check(
      'apply_patch',
      { command: patch(['*** Add File: src/feature.js']) },
      { cwd: '/tmp' }
    );
    assert.equal(result.blocked, false);
    assert.equal(result.skipRemainingChecks, true);
  });

  it('fails OPEN on an unparseable patch (advisory protector, C6)', () => {
    const result = protector.check(
      'apply_patch',
      { command: 'not a patch at all' },
      { cwd: '/tmp' }
    );
    assert.equal(result.blocked, false);
  });

  it('resolves relative targets against the payload cwd', () => {
    const dirProtector = createFileProtector({
      isProtected: (filePath) => (filePath.includes('/GH-9/.claims/') ? 'claims' : null),
    });
    const result = dirProtector.check(
      'apply_patch',
      { command: patch(['*** Update File: .claims/agent-1']) },
      { cwd: '/base/tasks/GH-9' }
    );
    assert.equal(result.blocked, true);
    assert.equal(result.match, 'claims');
  });
});

describe('createArtifactProtector — apply_patch vector', () => {
  function makeProtector(step) {
    return createArtifactProtector({
      artifacts: [{ basename: 'tasks.md', step: 'tasks', allowedSteps: ['tasks_gate'] }],
      getStepInProgress: () => step,
      getTicketId: () => 'GH-7',
    });
  }

  it('blocks an apply_patch to a step-gated artifact outside its steps', () => {
    const result = makeProtector('implement').check(
      'apply_patch',
      { command: patch(['*** Update File: /base/tasks/GH-7/tasks.md']) },
      { cwd: '/base/tasks/GH-7' }
    );
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'step');
    assert.equal(result.file, 'tasks.md');
    assert.match(result.message, /Cannot write tasks\.md/);
  });

  it('allows the same apply_patch during an allowed step', () => {
    const result = makeProtector('tasks').check(
      'apply_patch',
      { command: patch(['*** Update File: /base/tasks/GH-7/tasks.md']) },
      { cwd: '/base/tasks/GH-7' }
    );
    assert.equal(result.blocked, false);
  });

  it('resolves relative patch targets against the payload cwd (ticket scoping)', () => {
    const result = makeProtector('implement').check(
      'apply_patch',
      { command: patch(['*** Update File: tasks.md']) },
      { cwd: '/base/tasks/GH-7' }
    );
    assert.equal(result.blocked, true);
    assert.equal(result.rule, 'step');
  });

  it('ignores apply_patch targets outside the ticket folder', () => {
    const result = makeProtector('implement').check(
      'apply_patch',
      { command: patch(['*** Update File: /elsewhere/tasks.md']) },
      { cwd: '/base/tasks/GH-7' }
    );
    assert.equal(result.blocked, false);
  });

  it('fails OPEN on an unparseable patch', () => {
    const result = makeProtector('implement').check(
      'apply_patch',
      { command: 'garbage' },
      { cwd: '/base/tasks/GH-7' }
    );
    assert.equal(result.blocked, false);
  });
});
