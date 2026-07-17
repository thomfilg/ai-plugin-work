'use strict';

/**
 * PERMANENT FIXTURE — GH-665 regression suite. DO NOT DELETE.
 *
 * Pins the fix for the GH-665 bricked-session incident class: a PLAIN MAIN
 * SESSION whose opening prompt merely SAYS "use the commit-writer agent to
 * commit staged changes" (and whose text carries git tokens) was classified
 * as the commit-writer agent by name-substring matching against user prose.
 * Agent-gated guards then fired inside the user's main session — blocking
 * ordinary git/gh commands and bricking the session.
 *
 * The rule this suite pins (see lib/agent-identity.js, "The #665 rule"):
 * name-substring matching against prose is only permitted inside a transcript
 * POSITIVELY identified as a sidechain (`isSidechain` / `attributionAgent`
 * structural markers). Never in main-session text, never in command text.
 *
 * Two fixtures prove the gate is live, not dead:
 *   1. Regression: a markerless main-session transcript with the literal
 *      #665 prompt shape must classify as NOT commit-writer.
 *   2. Control: the SAME prompt in a transcript carrying an early
 *      `isSidechain: true` marker MUST classify as commit-writer — proving
 *      the negative assertion gates on structural markers rather than on a
 *      check that never matches anything.
 *
 * This suite is a permanent regression fixture. Do not delete it, weaken its
 * assertions, or fold it into another suite: it is the executable record of
 * the GH-665 incident class, and its removal would allow prose-based agent
 * classification to regress silently.
 *
 * Run: node --test plugins/work/scripts/workflows/lib/__tests__/agent-identity-665-regression.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isRunningInAgent, isSubagentFromInitialPrompt } = require('../agent-identity');

// Transcripts live in a private mkdtemp tmpdir (unpredictable name) so a
// predictable filename cannot be exploited via a symlink/race attack.
const TRANSCRIPT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-identity-665-'));
process.on('exit', () => {
  try {
    fs.rmSync(TRANSCRIPT_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// Build a claude JSONL transcript file from line objects; returns its path.
function writeTranscript(lines) {
  const tmp = path.join(
    TRANSCRIPT_DIR,
    `t-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`
  );
  fs.writeFileSync(tmp, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return tmp;
}

// The literal #665 prompt shape: an agent-name mention in user prose PLUS a
// command line carrying git tokens — exactly the text that misclassified a
// plain main session as commit-writer before the fix.
const GH665_PROMPT =
  'use the commit-writer agent to commit staged changes for GH-665\n' +
  'then run: git add -A && git commit -m "fix: guard the thing" && git push origin main';

// ─── Env hygiene: identity env vars must not decide these tests ─────────────

const SAVED_ENV_KEYS = ['CLAUDE_CURRENT_AGENT', 'CLAUDE_AGENT_TYPE', 'ENFORCE_HOOK_DEBUG'];
const savedEnv = {};

beforeEach(() => {
  for (const key of SAVED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of SAVED_ENV_KEYS) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
    else delete process.env[key];
  }
});

describe('GH-665 regression — markerless main session mentioning an agent name', () => {
  // No isSidechain, no attributionAgent: a plain main-session transcript.
  function markerlessFixture() {
    return writeTranscript([
      {
        type: 'user',
        message: { role: 'user', content: GH665_PROMPT },
      },
    ]);
  }

  it('isRunningInAgent must NOT classify the main session as commit-writer', () => {
    const transcriptPath = markerlessFixture();
    assert.equal(
      isRunningInAgent(transcriptPath, ['commit-writer'], {}),
      false,
      'GH-665 regression: a main session that merely SAYS "use the commit-writer ' +
        'agent" must never classify as commit-writer'
    );
  });

  it('isSubagentFromInitialPrompt must NOT match a markerless name mention', () => {
    const transcriptPath = markerlessFixture();
    assert.equal(
      isSubagentFromInitialPrompt(transcriptPath, ['commit-writer']),
      false,
      'GH-665 regression: prose name-mention matching is forbidden without a ' +
        'structural sidechain marker'
    );
  });
});

describe('GH-665 control — sidechain transcript with the same name mention', () => {
  // Identical prompt, but the transcript is POSITIVELY a sidechain: the early
  // `isSidechain: true` structural marker permits the name-mention fallback.
  // This control proves the negative assertions above gate on structural
  // markers rather than on a dead check that matches nothing.
  function sidechainFixture() {
    return writeTranscript([
      {
        type: 'user',
        isSidechain: true,
        message: { role: 'user', content: GH665_PROMPT },
      },
    ]);
  }

  it('isRunningInAgent classifies the sidechain transcript as commit-writer', () => {
    const transcriptPath = sidechainFixture();
    assert.equal(
      isRunningInAgent(transcriptPath, ['commit-writer'], {}),
      true,
      'control: the SAME prompt inside a genuine sidechain must still classify ' +
        'as commit-writer — otherwise the regression assertions test a dead gate'
    );
  });

  it('isSubagentFromInitialPrompt matches the sidechain name mention', () => {
    const transcriptPath = sidechainFixture();
    assert.equal(
      isSubagentFromInitialPrompt(transcriptPath, ['commit-writer']),
      true,
      'control: sidechain-gated name-mention matching must remain live'
    );
  });
});
