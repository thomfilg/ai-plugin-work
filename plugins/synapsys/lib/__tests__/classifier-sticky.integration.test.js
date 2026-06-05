'use strict';

// RED phase — Task 6 (GH-513) INTEGRATION (deliverable 6.1.4).
//
// Drives `classifyWithSticky` across a real tmpdir-backed sticky-state file
// (load → classify → save → reload) over 6 sequential prompts:
//   prompts 1..3 active   → sticky establishes
//   prompt  4   quiet     → stays active via hysteresis (AC5)
//   prompts 5..6 quiet    → drops on the 3rd quiet (AC6)
//
// No mocks — uses the real `lib/sticky-state.js` module end-to-end.
//
// Scenarios covered (verbatim titles for task-next.js gate):
//   - Sticky-domain hysteresis keeps a domain active after the signal stops
//   - Sticky-domain drops after 3 quiet prompts

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { classifyWithSticky } = require('../classifier');
const { loadStickyState, saveStickyState } = require('../sticky-state');

function tmpStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-classifier-sticky-int-'));
  return path.join(dir, 'sticky-domains.json');
}

function mkRegistry() {
  const roots = new Map();
  const git = { leaves: new Map() };
  git.leaves.set('plumbing-ops', {
    signal_prompt: [/\bgit\s+merge\b/i],
    signal_pretool: [/\bgit\s+rebase\b/i],
  });
  roots.set('git', git);
  return { roots };
}

test('integration: Sticky-domain hysteresis keeps a domain active after the signal stops, and Sticky-domain drops after 3 quiet prompts', () => {
  const file = tmpStateFile();
  const registry = mkRegistry();
  const sessionId = 's-int';
  const baseNow = 1_700_000_000_000;

  const prompts = [
    { text: 'please git merge feature', active: true },   // 1
    { text: 'continue git merge work',  active: true },   // 2
    { text: 'finalize git merge step',  active: true },   // 3 — sticky establishes
    { text: 'unrelated question',       active: false },  // 4 — hysteresis keeps active
    { text: 'still unrelated',          active: false },  // 5
    { text: 'totally different topic',  active: false },  // 6 — should drop
  ];

  const activeHistory = [];
  for (let i = 0; i < prompts.length; i++) {
    // load → classify → save → reload via the real fs.
    const state = loadStickyState({ filePath: file, now: baseNow + i * 1000 });
    const result = classifyWithSticky({
      prompt: prompts[i].text,
      recentToolCalls: [],
      registry,
      stickyState: state,
      sessionId,
      now: baseNow + i * 1000,
    });
    saveStickyState({ state: result.nextStickyState, filePath: file });
    activeHistory.push(result.activeDomains.has('git'));
  }

  // Prompts 1..3 raw active → git always present.
  assert.equal(activeHistory[0], true, 'prompt 1 active');
  assert.equal(activeHistory[1], true, 'prompt 2 active');
  assert.equal(activeHistory[2], true, 'prompt 3 active');

  // Prompt 4 quiet but sticky → still active (AC5).
  assert.equal(
    activeHistory[3],
    true,
    'AC5: Sticky-domain hysteresis keeps a domain active after the signal stops'
  );

  // Prompt 6 (third quiet in a row) → dropped (AC6).
  assert.equal(
    activeHistory[5],
    false,
    'AC6: Sticky-domain drops after 3 quiet prompts'
  );

  // File should exist and parse as JSON.
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(typeof persisted, 'object');
});
