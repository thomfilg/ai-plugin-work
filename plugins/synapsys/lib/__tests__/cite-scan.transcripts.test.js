'use strict';

/**
 * WP-05: cite-scan transcript extraction over BOTH transcript formats.
 *
 * `extractFromTranscript` must keep reading Claude project JSONL (and the
 * legacy `{role, content}` rows) byte-identically, and additionally resolve
 * the last assistant text from a codex session rollout (line-1 session_meta,
 * `response_item` message records — ground truth §8.1) via the vendored
 * dual-format reader. `extractResponseText` must prefer the codex Stop
 * payload's inline `last_assistant_message` before falling back to the
 * transcript.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { extractFromTranscript, extractResponseText } = require(
  path.resolve(__dirname, '..', 'cite-scan')
);

const REPO_ROLLOUT = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'tests',
  'fixtures',
  'runtime',
  'codex',
  'rollout.jsonl'
);

function writeTmp(name, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-cite-scan-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return file;
}

test('extractFromTranscript reads the last assistant text from a claude transcript', () => {
  const file = writeTmp('claude.jsonl', [
    { type: 'user', message: { content: 'do the thing' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'first answer' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'final answer' }] } },
  ]);
  assert.equal(extractFromTranscript(file), 'final answer');
});

test('extractFromTranscript keeps supporting the legacy {role, content} row shape', () => {
  const file = writeTmp('legacy.jsonl', [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'legacy final answer' },
  ]);
  assert.equal(extractFromTranscript(file), 'legacy final answer');
});

test('extractFromTranscript reads the last assistant text from a codex rollout', () => {
  const file = writeTmp('rollout.jsonl', [
    { type: 'session_meta', payload: { id: 's1', cwd: '/tmp/x' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'please fix it' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'codex final answer' }],
      },
    },
  ]);
  assert.equal(extractFromTranscript(file), 'codex final answer');
});

test('extractFromTranscript resolves the checked-in probe rollout fixture', () => {
  const text = extractFromTranscript(REPO_ROLLOUT);
  assert.match(text, /STEP1 done\./);
});

test('extractFromTranscript stays fail-open on unknown formats and missing files', () => {
  const file = writeTmp('junk.jsonl', [{ kind: 'not-a-transcript' }]);
  assert.equal(extractFromTranscript(file), '');
  assert.equal(extractFromTranscript(path.join(os.tmpdir(), 'nope-does-not-exist.jsonl')), '');
});

test('extractResponseText prefers the codex last_assistant_message payload field', () => {
  const payload = {
    last_assistant_message: 'inline codex answer',
    transcript_path: REPO_ROLLOUT,
  };
  assert.equal(extractResponseText(payload), 'inline codex answer');
});

test('extractResponseText falls back to the rollout when only transcript_path is present', () => {
  assert.match(extractResponseText({ transcript_path: REPO_ROLLOUT }), /STEP1 done\./);
});

test('extractResponseText claude order unchanged: non-empty response wins', () => {
  const payload = { response: 'claude response', last_assistant_message: 'codex answer' };
  assert.equal(extractResponseText(payload), 'claude response');
});
