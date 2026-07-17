'use strict';

/**
 * WP-07: the enforce-tdd-on-stop developer-identification FALLBACK
 * (transcriptIsDeveloperDispatch — used only when the SubagentStop payload
 * carries no agent_type) must read codex rollout transcripts through the
 * vendored dual-format reader. Only authored event_msg/user_message records
 * count as the dispatch prompt; response_item user rows can carry injected
 * context and are never trusted.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { transcriptIsDeveloperDispatch } = require(
  path.resolve(__dirname, '..', 'hooks', 'enforce-tdd-on-stop-helpers')
);

const DISPATCH_PROMPT =
  'You are a self-paced TDD agent. Run node task-next.js TEST-1 task1 and follow it.';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-stop-rt-'));
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let fileCounter = 0;

function writeRollout(records) {
  const file = path.join(tmpDir, `rollout-${(fileCounter += 1)}.jsonl`);
  const meta = {
    type: 'session_meta',
    payload: { id: 's-1', cwd: '/tmp/x', timestamp: '2026-07-07T00:00:00Z' },
  };
  fs.writeFileSync(file, [meta, ...records].map((r) => JSON.stringify(r)).join('\n'), {
    mode: 0o600,
  });
  return file;
}

describe('transcriptIsDeveloperDispatch — codex rollout leg', () => {
  it('matches a rollout whose FIRST authored user message is the dispatch prompt', () => {
    const file = writeRollout([
      { type: 'event_msg', payload: { type: 'user_message', message: DISPATCH_PROMPT } },
    ]);
    assert.equal(transcriptIsDeveloperDispatch(file), true);
  });

  it('does not match when the markers only appear in a response_item user row (injected)', () => {
    const file = writeRollout([
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: DISPATCH_PROMPT }],
        },
      },
      { type: 'event_msg', payload: { type: 'user_message', message: 'unrelated prompt' } },
    ]);
    assert.equal(transcriptIsDeveloperDispatch(file), false);
  });

  it('does not match a rollout without the structural markers', () => {
    const file = writeRollout([
      { type: 'event_msg', payload: { type: 'user_message', message: 'please review the PR' } },
    ]);
    assert.equal(transcriptIsDeveloperDispatch(file), false);
  });

  it('claude transcript first-user-message detection unchanged (characterization)', () => {
    const file = path.join(tmpDir, 'claude-transcript.jsonl');
    fs.writeFileSync(
      file,
      [
        { type: 'user', message: { content: DISPATCH_PROMPT } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
      { mode: 0o600 }
    );
    assert.equal(transcriptIsDeveloperDispatch(file), true);
  });
});

// GH-767 Task 5 — require-path assertions ONLY (no behavior assertions):
// the five migrated consumers must obtain identity through the canonical
// lib/agent-identity.js module instead of inline payload triple-reads.
describe('GH-767 consumer migration — agent-identity require paths', () => {
  const WORKFLOWS_ROOT = path.resolve(__dirname, '..', '..');
  const MIGRATED_FILES = [
    'work-implement/hooks/enforce-developer-detect.js',
    'work-implement/hooks/enforce-tdd-on-stop.js',
    'work-implement/hooks/enforce-tdd-on-stop-helpers.js',
    'work/agents/developer-quality-gate.js',
    'work-pr/agents/lib/hook-io.js',
  ];

  for (const rel of MIGRATED_FILES) {
    it(`${rel} reads identity via the module boundary`, () => {
      const source = fs.readFileSync(path.join(WORKFLOWS_ROOT, rel), 'utf8');
      // The helpers file has no payload read — its swap is the dual-format
      // transcript reader; every other file requires agent-identity directly.
      const boundaryRe = rel.endsWith('enforce-tdd-on-stop-helpers.js')
        ? /require\([^)]*runtime[^)]*transcript[^)]*\)/
        : /require\([^)]*agent-identity[^)]*\)/;
      assert.match(source, boundaryRe);
      // The divergent inline triple-read is deleted (no raw payload-field
      // fallback chains outside the module).
      assert.doesNotMatch(source, /\.agent_type\s*\|\|/);
      assert.doesNotMatch(source, /\.agent_name\s*\|\|/);
    });
  }
});
