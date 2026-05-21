'use strict';

/**
 * End-to-end smoke test for brief-next.js — walks every phase of the
 * brief workflow (inputs → overlap → draft → validate → memorize → done)
 * against a temp-dir synthetic ticket. Spawns brief-next.js directly and
 * pre-mints the agent-gated token so the hook isn't required.
 *
 * The test exists to:
 *   1. Surface bugs in brief-next.js before real /work sessions hit them.
 *   2. Prove that brief-phase-state.js's record/transition chain works
 *      after the same auto-init pattern used in task-next.js.
 *   3. Provide a regression anchor so future edits to either script can't
 *      silently break the full cycle.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BRIEF_NEXT = path.resolve(__dirname, '..', 'brief-next.js');
const TOKEN_DIR = '/tmp/.claude-write-tokens';

function mintToken(scriptBasename) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(TOKEN_DIR, scriptBasename),
    JSON.stringify({
      agent: 'brief-writer',
      timestamp: Date.now(),
      tasksBase: null,
    }),
    { mode: 0o600 }
  );
}

function runBriefNext(ticket, env) {
  mintToken('brief-next.js');
  mintToken('brief-phase-state.js');
  return spawnSync(process.execPath, [BRIEF_NEXT, ticket], {
    cwd: env.cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      TASKS_BASE: env.TASKS_BASE,
      NEXT_SCRIPT_LOG: '0',
    },
  });
}

describe('brief-next.js full cycle (regression for the brief pipeline)', () => {
  let tmp;
  let tasksBase;
  let worktree;
  const ticket = 'GH-99981';
  let tasksDir;
  let phaseFile;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-next-'));
    tasksBase = path.join(tmp, 'tasks');
    worktree = path.join(tmp, 'wt');
    tasksDir = path.join(tasksBase, ticket);
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });

    // Workspace marker.
    fs.writeFileSync(
      path.join(tasksDir, 'ticket.json'),
      JSON.stringify({ id: ticket, title: 'Add LRU cache to user-profile fetcher' })
    );

    // Minimal related-tickets.json with no siblings — keeps the test
    // simple but exercises the manifest-read path.
    fs.writeFileSync(
      path.join(tasksDir, 'related-tickets.json'),
      JSON.stringify({
        self: { id: ticket, title: 'Add LRU cache' },
        parent: null,
        siblings: [],
        blockedBy: [],
        dependsOn: [],
        relatedTo: [],
        fetchedAt: new Date().toISOString(),
      })
    );

    spawnSync('git', ['init', '-q', worktree], { stdio: 'ignore' });
    phaseFile = path.join(tasksDir, 'brief-phase.json');
  });

  after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('phase 1 — INPUTS: with no linked tickets, advances to overlap immediately', () => {
    const r = runBriefNext(ticket, { cwd: worktree, TASKS_BASE: tasksBase });
    const combined = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. Output:\n${combined}`);
    assert.equal(fs.existsSync(phaseFile), true, 'phase state file should be created by init');

    const state = JSON.parse(fs.readFileSync(phaseFile, 'utf8'));
    assert.equal(
      state.currentPhase,
      'overlap',
      `expected currentPhase=overlap, got ${state.currentPhase}`
    );
    assert.ok(state.phases?.inputs, 'inputs phase evidence should be recorded');
  });

  it('phase 2 — OVERLAP: writing sibling-overlap.md (empty since no siblings) advances to draft', () => {
    // With zero linked tickets, the overlap analysis still requires the file
    // to exist (the script validates one section per linked ticket; zero
    // tickets = no required sections, so an empty file should pass).
    fs.writeFileSync(
      path.join(tasksDir, 'sibling-overlap.md'),
      '# Sibling Overlap Analysis\n\n_No linked tickets._\n'
    );

    const r = runBriefNext(ticket, { cwd: worktree, TASKS_BASE: tasksBase });
    const combined = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. Output:\n${combined}`);

    const state = JSON.parse(fs.readFileSync(phaseFile, 'utf8'));
    assert.equal(
      state.currentPhase,
      'draft',
      `expected currentPhase=draft, got ${state.currentPhase}`
    );
    assert.ok(state.phases?.overlap, 'overlap phase evidence should be recorded');
  });

  it('phase 3 — DRAFT: writing complete brief.md advances to validate', () => {
    fs.writeFileSync(
      path.join(tasksDir, 'brief.md'),
      [
        '# Brief: Add LRU cache',
        '',
        '## Problem Statement',
        'Repeat fetches of user profiles hammer the upstream service.',
        '',
        '## Goal',
        'Cut downstream traffic ~80% via an in-process LRU cache.',
        '',
        '## Target Users',
        '- Internal services calling fetchUserProfile()',
        '',
        '## Requirements',
        '### Must Have (P0)',
        '1. LRU cache with 50-entry cap and 60s TTL in front of fetchUserProfile().',
        '',
        '## Constraints',
        '- Per-process, not shared across workers.',
        '',
        '## Out of scope (sibling-owned)',
        '_None._',
        '',
        '## Success Metrics',
        '- 80% reduction in downstream fetch volume in load tests.',
        '',
        '## Open Questions',
        '- _None._',
        '',
      ].join('\n')
    );

    const r = runBriefNext(ticket, { cwd: worktree, TASKS_BASE: tasksBase });
    const combined = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. Output:\n${combined}`);

    const state = JSON.parse(fs.readFileSync(phaseFile, 'utf8'));
    assert.equal(
      state.currentPhase,
      'validate',
      `expected currentPhase=validate, got ${state.currentPhase}`
    );
    assert.ok(state.phases?.draft, 'draft phase evidence should be recorded');
  });

  it('phase 4 — VALIDATE: cross-checks pass, advances to memorize', () => {
    const r = runBriefNext(ticket, { cwd: worktree, TASKS_BASE: tasksBase });
    const combined = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. Output:\n${combined}`);

    const state = JSON.parse(fs.readFileSync(phaseFile, 'utf8'));
    assert.equal(
      state.currentPhase,
      'memorize',
      `expected currentPhase=memorize, got ${state.currentPhase}`
    );
    assert.ok(state.phases?.validate, 'validate phase evidence should be recorded');
  });

  it('phase 5 — MEMORIZE: auto-completes when no memory plugin detected', () => {
    // detectMemoryPlugin() scans ~/.claude/plugins/{marketplaces,cache}
    // for cortex/mem0. In CI / tmp-only runs there is none, so the script
    // should record memorize with summary=no-memory-plugin and advance to done.
    const r = runBriefNext(ticket, { cwd: worktree, TASKS_BASE: tasksBase });
    const combined = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. Output:\n${combined}`);

    const state = JSON.parse(fs.readFileSync(phaseFile, 'utf8'));
    // If a real memory plugin is present on the dev box, currentPhase
    // stays at memorize (agent has to touch .brief-memorized). Accept
    // either done OR memorize so the test isn't flaky on dev boxes.
    assert.ok(
      state.currentPhase === 'done' || state.currentPhase === 'memorize',
      `expected currentPhase=done|memorize, got ${state.currentPhase}`
    );
    assert.ok(
      state.phases?.memorize || state.currentPhase === 'memorize',
      'memorize phase should have been recorded OR still be current'
    );
  });
});
