/**
 * Tests for policies/evidence-recorder.js
 *
 * Run: node --test workflows/lib/hooks/policies/__tests__/evidence-recorder.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  loadEvidence,
  saveEvidence,
  recordEvidenceEntry,
  clearBackwardEvidence,
} = require('../evidence-recorder');

let TMP_BASE;
const TICKET = 'EVTEST';
const safeTicketPath = (id) => id;

beforeEach(() => {
  TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'evtest-'));
});

afterEach(() => {
  try {
    fs.rmSync(TMP_BASE, { recursive: true, force: true });
  } catch {}
});

describe('evidence-recorder: loadEvidence', () => {
  it('returns empty object when file does not exist', () => {
    const e = loadEvidence({
      tasksBase: TMP_BASE,
      ticketId: TICKET,
      evidenceFile: '.x.json',
      safeTicketPath,
    });
    assert.deepEqual(e, {});
  });

  it('reads existing evidence', () => {
    const dir = path.join(TMP_BASE, TICKET);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.x.json'), JSON.stringify({ a: { executed: true } }));
    const e = loadEvidence({
      tasksBase: TMP_BASE,
      ticketId: TICKET,
      evidenceFile: '.x.json',
      safeTicketPath,
    });
    assert.deepEqual(e, { a: { executed: true } });
  });

  it('returns empty object on malformed JSON', () => {
    const dir = path.join(TMP_BASE, TICKET);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.x.json'), '{not json');
    const e = loadEvidence({
      tasksBase: TMP_BASE,
      ticketId: TICKET,
      evidenceFile: '.x.json',
      safeTicketPath,
    });
    assert.deepEqual(e, {});
  });
});

describe('evidence-recorder: saveEvidence', () => {
  it('writes evidence atomically and creates dir', () => {
    saveEvidence({
      tasksBase: TMP_BASE,
      ticketId: TICKET,
      evidenceFile: '.x.json',
      evidence: { a: { executed: true } },
      safeTicketPath,
    });
    const got = JSON.parse(fs.readFileSync(path.join(TMP_BASE, TICKET, '.x.json'), 'utf-8'));
    assert.deepEqual(got, { a: { executed: true } });
  });

  it('overwrites existing evidence', () => {
    saveEvidence({
      tasksBase: TMP_BASE,
      ticketId: TICKET,
      evidenceFile: '.x.json',
      evidence: { a: 1 },
      safeTicketPath,
    });
    saveEvidence({
      tasksBase: TMP_BASE,
      ticketId: TICKET,
      evidenceFile: '.x.json',
      evidence: { b: 2 },
      safeTicketPath,
    });
    const got = JSON.parse(fs.readFileSync(path.join(TMP_BASE, TICKET, '.x.json'), 'utf-8'));
    assert.deepEqual(got, { b: 2 });
  });
});

describe('evidence-recorder: recordEvidenceEntry', () => {
  it('builds an evidence entry from tool call', () => {
    const e = recordEvidenceEntry({
      toolName: 'Bash',
      toolInput: { command: 'pnpm test' },
    });
    assert.equal(e.executed, true);
    assert.equal(e.tool, 'Bash');
    assert.equal(e.command, 'pnpm test');
    assert.ok(e.timestamp);
  });

  it('uses skill name for Skill tool', () => {
    const e = recordEvidenceEntry({
      toolName: 'Skill',
      toolInput: { skill: 'foo' },
    });
    assert.equal(e.command, 'foo');
  });

  it('uses subagent_type for Task/Agent', () => {
    const e = recordEvidenceEntry({
      toolName: 'Task',
      toolInput: { subagent_type: 'qa-feature-tester' },
    });
    assert.equal(e.command, 'qa-feature-tester');
  });

  it('falls back to (unknown)', () => {
    const e = recordEvidenceEntry({ toolName: 'Other', toolInput: {} });
    assert.equal(e.command, '(unknown)');
  });
});

describe('evidence-recorder: clearBackwardEvidence', () => {
  it('clears evidence for steps after target through current', () => {
    const evidence = { a: { executed: true }, b: { executed: true }, c: { executed: true } };
    const result = clearBackwardEvidence({
      evidence,
      steps: ['a', 'b', 'c', 'd'],
      currentStep: 'c',
      targetStep: 'a',
    });
    // target itself preserved; b and c cleared
    assert.ok(result.a);
    assert.equal(result.b, undefined);
    assert.equal(result.c, undefined);
  });

  it('does not clear forward transitions', () => {
    const evidence = { a: { executed: true } };
    const result = clearBackwardEvidence({
      evidence,
      steps: ['a', 'b', 'c'],
      currentStep: 'a',
      targetStep: 'c',
    });
    assert.deepEqual(result, evidence);
  });

  it('handles missing target/current gracefully', () => {
    const evidence = { a: { executed: true } };
    const result = clearBackwardEvidence({
      evidence,
      steps: ['a', 'b'],
      currentStep: null,
      targetStep: 'a',
    });
    assert.deepEqual(result, evidence);
  });
});
