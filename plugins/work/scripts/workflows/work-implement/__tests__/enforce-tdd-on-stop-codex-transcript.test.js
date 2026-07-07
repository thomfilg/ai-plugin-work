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

const cleanupFiles = [];
after(() => {
  while (cleanupFiles.length > 0) {
    try {
      fs.unlinkSync(cleanupFiles.pop());
    } catch {
      /* already gone */
    }
  }
});

function writeRollout(records) {
  const file = path.join(
    os.tmpdir(),
    `tdd-stop-rt-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`
  );
  const meta = {
    type: 'session_meta',
    payload: { id: 's-1', cwd: '/tmp/x', timestamp: '2026-07-07T00:00:00Z' },
  };
  fs.writeFileSync(file, [meta, ...records].map((r) => JSON.stringify(r)).join('\n'));
  cleanupFiles.push(file);
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
    const file = path.join(
      os.tmpdir(),
      `tdd-stop-claude-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`
    );
    fs.writeFileSync(
      file,
      [
        { type: 'user', message: { content: DISPATCH_PROMPT } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n')
    );
    cleanupFiles.push(file);
    assert.equal(transcriptIsDeveloperDispatch(file), true);
  });
});
