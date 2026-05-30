'use strict';

/**
 * Dispatcher golden-output regression test (GH-443, Task 2).
 *
 * Regression contract: refactors to `plugins/synapsys/lib/matcher.js` (notably
 * the MatchResult conversion in Task 1) MUST NOT change the byte-for-byte
 * stdout of `plugins/synapsys/hooks/synapsys.js` when invoked with the same
 * payload against the same store layout.
 *
 * Covers:
 *   - R3 (Dispatcher stdout byte-identical; backward compatibility baseline).
 *   - G10 (Existing dispatcher hook output is unchanged after MatchResult
 *     refactor).
 *
 * If this test fails after a matcher edit, the matcher edit broke the
 * dispatcher's externally-observable contract. Either revert, or update the
 * golden ONLY with explicit reviewer sign-off (and update R3/G10 in the spec).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DISPATCHER = path.resolve(__dirname, '..', '..', 'hooks', 'synapsys.js');

const MEMORY_NAME = 'golden-prompt-memory';
const KNOWN_PROMPT = 'golden dispatcher regression prompt';
const MEMORY_BODY =
  'Body line one for the golden regression memory.\nBody line two.';
const MEMORY_DESCRIPTION = 'Golden regression memory for dispatcher stdout.';

// Captured verbatim from `node plugins/synapsys/hooks/synapsys.js
// UserPromptSubmit` invoked with the fixture store + payload below (post
// Task-1 MatchResult refactor). Re-record ONLY with explicit reviewer sign-off
// — silent updates here defeat the regression contract.
const EXPECTED_GOLDEN_STDOUT =
  '[synapsys:local] golden-prompt-memory — Golden regression memory for dispatcher stdout.\n\n' +
  'Body line one for the golden regression memory.\n' +
  'Body line two.';

function makeFixtureStore() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-dispatcher-golden-'));
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ projectName: 'dispatcher-golden-fixture' })
  );

  const memoryFile = path.join(storeDir, `${MEMORY_NAME}.md`);
  const frontmatter = [
    '---',
    `name: ${MEMORY_NAME}`,
    `description: ${MEMORY_DESCRIPTION}`,
    'events: UserPromptSubmit',
    'trigger_prompt: golden dispatcher regression',
    'trigger_session: false',
    'inject: full',
    '---',
    '',
    MEMORY_BODY,
    '',
  ].join('\n');
  fs.writeFileSync(memoryFile, frontmatter);

  return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

test('dispatcher stdout for UserPromptSubmit payload matches golden', (t) => {
  const { cwd, cleanup } = makeFixtureStore();
  t.after(cleanup);

  const payload = {
    hook_event_name: 'UserPromptSubmit',
    prompt: KNOWN_PROMPT,
    cwd,
  };

  const result = spawnSync(
    process.execPath,
    [DISPATCHER, 'UserPromptSubmit'],
    {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, SYNAPSYS_NO_SETUP_HINT: '1' },
    }
  );

  assert.equal(result.status, 0, `dispatcher exited non-zero: stderr=${result.stderr}`);
  assert.equal(
    result.stdout,
    EXPECTED_GOLDEN_STDOUT,
    'dispatcher stdout drifted from golden baseline (R3/G10 regression)'
  );
});
