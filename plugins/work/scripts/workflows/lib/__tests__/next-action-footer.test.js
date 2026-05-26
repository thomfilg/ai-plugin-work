'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderNextActionFooter, dirFor } = require('../next-action-footer');

test('BLOCKED footer tells agent to fix + re-run', () => {
  const out = renderNextActionFooter({
    scriptName: 'brief-next.js',
    ticket: 'ECHO-1',
    phase: 'draft',
    terminalPhase: 'done',
    advanced: false,
    blockReason: 'Missing brief.md',
  });
  assert.match(out, /NEXT_ACTION: fix the block/);
  assert.match(out, /brief-next\.js ECHO-1/);
});

test('DONE footer tells agent to STOP', () => {
  const out = renderNextActionFooter({
    scriptName: 'spec-next.js',
    ticket: 'ECHO-2',
    phase: 'done',
    terminalPhase: 'done',
    advanced: true,
    blockReason: '',
  });
  assert.match(out, /NEXT_ACTION: DONE/);
  assert.match(out, /Do NOT re-run/);
});

test('ADVANCED-but-not-done footer tells agent to re-run', () => {
  const out = renderNextActionFooter({
    scriptName: 'tasks-next.js',
    ticket: 'ECHO-3',
    phase: 'draft',
    terminalPhase: 'done',
    advanced: true,
    blockReason: '',
  });
  assert.match(out, /NEXT_ACTION: perform the action above/);
  assert.match(out, /phase "draft"/);
  assert.match(out, /tasks-next\.js ECHO-3/);
});

test('WAITING (ok=false, no errors) treated like ADVANCED — re-run', () => {
  const out = renderNextActionFooter({
    scriptName: 'completion-next.js',
    ticket: 'ECHO-4',
    phase: 'memorize',
    terminalPhase: 'done',
    advanced: false,
    blockReason: '',
  });
  assert.match(out, /NEXT_ACTION: perform/);
  assert.match(out, /completion-next\.js ECHO-4/);
});

test('dirFor maps every known runner', () => {
  assert.equal(dirFor('brief-next.js'), 'work-brief');
  assert.equal(dirFor('spec-next.js'), 'work-spec');
  assert.equal(dirFor('tasks-next.js'), 'work-tasks');
  assert.equal(dirFor('pr-next.js'), 'work-pr-step');
  assert.equal(dirFor('ci-next.js'), 'work-ci');
  assert.equal(dirFor('completion-next.js'), 'work-completion-checker');
  assert.equal(dirFor('code-next.js'), 'work-code-checker');
  assert.equal(dirFor('unknown.js'), '');
});
