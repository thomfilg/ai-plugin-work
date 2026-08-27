'use strict';

/**
 * memory-record.test.js
 *
 * The twelve `memorize` phases used to gate on a token the agent minted
 * itself — `touch .spec-memorized`, an appended `<!-- tasks-memorized -->`, a
 * `"memorized": true` key. Each proved a write happened and nothing more, so
 * the phase passed without the thing it was checking for.
 *
 * These cases pin the replacement: the record has to carry substance, it is
 * scoped so one phase cannot discharge another's gate, and a docs record is
 * re-read from disk rather than trusted.
 *
 * Run: node --test workflows/lib/__tests__/memory-record.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  appendRecord,
  clearScope,
  evaluateScope,
  readRecords,
  validateMemorizePhase,
  MIN_SUMMARY_CHARS,
} = require('../memory-record');

const MEMORY = { name: 'cortex', rememberTool: 'mcp__cortex__remember' };
const REAL_SUMMARY =
  'Saved the cleanup outcome: branch feature/x deleted locally and on the remote, both tmux ' +
  'sessions killed, worktree left in place because it still held untracked scratch files.';

function tmpTicket() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-record-'));
  const tasksDir = path.join(root, 'tasks', 'ECHO-4242');
  fs.mkdirSync(tasksDir, { recursive: true });
  return { root, tasksDir, ticket: 'ECHO-4242', worktreeRoot: root };
}

const cleanup = (t) => fs.rmSync(t.root, { recursive: true, force: true });

test('a memory record needs a substantive summary, not a token', () => {
  const t = tmpTicket();
  try {
    const ctx = { ...t, memory: MEMORY };
    assert.equal(validateMemorizePhase({ scope: 'cleanup', ctx }).ok, false);

    // The shape a sentinel had: present, but saying nothing.
    appendRecord(t.tasksDir, t.ticket, {
      scope: 'cleanup',
      sink: 'memory',
      memory: MEMORY.name,
      tool: MEMORY.rememberTool,
      summary: 'done',
    });
    assert.equal(
      validateMemorizePhase({ scope: 'cleanup', ctx }).ok,
      false,
      'a one-word summary is the sentinel in another costume'
    );

    appendRecord(t.tasksDir, t.ticket, {
      scope: 'cleanup',
      sink: 'memory',
      memory: MEMORY.name,
      tool: MEMORY.rememberTool,
      summary: REAL_SUMMARY,
    });
    const v = validateMemorizePhase({ scope: 'cleanup', ctx });
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.match(v.summary, /via=cortex/);
  } finally {
    cleanup(t);
  }
});

test('padding does not count toward the substantive minimum', () => {
  const t = tmpTicket();
  try {
    appendRecord(t.tasksDir, t.ticket, {
      scope: 'spec',
      sink: 'memory',
      memory: MEMORY.name,
      tool: MEMORY.rememberTool,
      summary: `${'-'.repeat(5000)}x`,
    });
    assert.equal(
      validateMemorizePhase({ scope: 'spec', ctx: { ...t, memory: MEMORY } }).ok,
      false,
      'substance is measured after filler and padding are stripped'
    );
  } finally {
    cleanup(t);
  }
});

test('a record for one scope does not discharge another scope', () => {
  const t = tmpTicket();
  try {
    const ctx = { ...t, memory: MEMORY };
    appendRecord(t.tasksDir, t.ticket, {
      scope: 'spec',
      sink: 'memory',
      memory: MEMORY.name,
      tool: MEMORY.rememberTool,
      summary: REAL_SUMMARY,
    });
    assert.equal(validateMemorizePhase({ scope: 'spec', ctx }).ok, true);
    assert.equal(
      validateMemorizePhase({ scope: 'cleanup', ctx }).ok,
      false,
      'twelve phases share one file — scope is what keeps them distinct'
    );
  } finally {
    cleanup(t);
  }
});

test('with no memory plugin the record must reach worktree docs, not nowhere', () => {
  const t = tmpTicket();
  try {
    const ctx = { ...t, memory: null };
    // A memory-sink record claims a plugin that does not exist here.
    appendRecord(t.tasksDir, t.ticket, {
      scope: 'reports',
      sink: 'memory',
      memory: 'cortex',
      tool: 'mcp__cortex__remember',
      summary: REAL_SUMMARY,
    });
    assert.equal(validateMemorizePhase({ scope: 'reports', ctx }).ok, false);

    const notePath = path.join(t.tasksDir, 'reports-memory.md');
    fs.writeFileSync(notePath, 'x'.repeat(250));
    appendRecord(t.tasksDir, t.ticket, {
      scope: 'reports',
      sink: 'docs',
      path: notePath,
      summary: REAL_SUMMARY,
    });
    assert.equal(validateMemorizePhase({ scope: 'reports', ctx }).ok, true);
  } finally {
    cleanup(t);
  }
});

test('a docs record is re-read at gate time, so deleting the file fails the phase', () => {
  const t = tmpTicket();
  try {
    const ctx = { ...t, memory: null };
    const notePath = path.join(t.tasksDir, 'qa-memory.md');
    fs.writeFileSync(notePath, 'x'.repeat(250));
    appendRecord(t.tasksDir, t.ticket, {
      scope: 'qa',
      sink: 'docs',
      path: notePath,
      summary: REAL_SUMMARY,
    });
    assert.equal(validateMemorizePhase({ scope: 'qa', ctx }).ok, true);

    fs.rmSync(notePath);
    assert.equal(
      validateMemorizePhase({ scope: 'qa', ctx }).ok,
      false,
      'a sentinel would happily pass here — that is the whole difference'
    );
  } finally {
    cleanup(t);
  }
});

test('a docs record outside the allowed roots is refused', () => {
  const t = tmpTicket();
  try {
    // /etc/services is readable and long: existence and substance both hold,
    // of entirely the wrong file. Containment is what rejects it.
    appendRecord(t.tasksDir, t.ticket, {
      scope: 'ci',
      sink: 'docs',
      path: '/etc/services',
      summary: REAL_SUMMARY,
    });
    assert.equal(validateMemorizePhase({ scope: 'ci', ctx: { ...t, memory: null } }).ok, false);
  } finally {
    cleanup(t);
  }
});

test('wait mode signals no-advance (empty errors) rather than a refusal', () => {
  const t = tmpTicket();
  const ctx = { ...t, memory: MEMORY };
  try {
    const waiting = validateMemorizePhase({ scope: 'brief', ctx, wait: true });
    assert.equal(waiting.ok, false);
    assert.deepEqual(waiting.errors, [], 'WAIT is ok:false with EMPTY errors');

    const blocking = validateMemorizePhase({ scope: 'brief', ctx });
    assert.equal(blocking.ok, false);
    assert.ok(blocking.errors.length > 0, 'a blocking phase must say what to do');
    assert.match(blocking.errors[0], /memory-note\.js record/);
  } finally {
    cleanup(t);
  }
});

test('the failure names the substantive minimum so it is actionable', () => {
  const t = tmpTicket();
  try {
    appendRecord(t.tasksDir, t.ticket, {
      scope: 'tasks',
      sink: 'memory',
      memory: MEMORY.name,
      tool: MEMORY.rememberTool,
      summary: 'wip',
    });
    const v = evaluateScope({
      records: readRecords(t.tasksDir),
      scope: 'tasks',
      memoryConfigured: true,
      worktreeRoot: t.worktreeRoot,
      tasksDir: t.tasksDir,
    });
    assert.equal(v.ok, false);
    assert.match(v.reason, new RegExp(String(MIN_SUMMARY_CHARS)));
  } finally {
    cleanup(t);
  }
});

test('clearScope drops one phase and leaves the others standing', () => {
  const t = tmpTicket();
  try {
    const ctx = { ...t, memory: MEMORY };
    for (const scope of ['spec', 'tasks']) {
      appendRecord(t.tasksDir, t.ticket, {
        scope,
        sink: 'memory',
        memory: MEMORY.name,
        tool: MEMORY.rememberTool,
        summary: REAL_SUMMARY,
      });
    }
    clearScope(t.tasksDir, t.ticket, 'spec');
    assert.equal(validateMemorizePhase({ scope: 'spec', ctx }).ok, false);
    assert.equal(validateMemorizePhase({ scope: 'tasks', ctx }).ok, true);
  } finally {
    cleanup(t);
  }
});

test('unreadable records read as none, not as satisfied', () => {
  const t = tmpTicket();
  try {
    fs.writeFileSync(path.join(t.tasksDir, '.memory-records.json'), '{ not json');
    assert.deepEqual(readRecords(t.tasksDir), []);
    assert.equal(validateMemorizePhase({ scope: 'spec', ctx: { ...t, memory: MEMORY } }).ok, false);
  } finally {
    cleanup(t);
  }
});
