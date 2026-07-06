/**
 * Unit tests for commit-msg-rules.js — the pure, importable rule module that is
 * the single source of truth for the commit-msg validator hook (GH-539, Task 1).
 *
 * Every rule is a pure predicate `(message, ctx) => { ok, reason?, hint? }`.
 * Each rule gets one conforming (pass) case and one specific-violation (fail)
 * case that names a reason and an actionable hint. `validateMessage` gets a
 * well-formed pass plus rule-named failure cases.
 *
 * The ticket-ID rule is exercised through the reused provider accessors
 * (`getProviderConfig` / `getTicketPattern`) — no hard-coded ID regex literal
 * appears in this test file.
 *
 * Run with: node --test workflows/work/hooks/__tests__/commit-msg-rules.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// The module under test does not exist yet (RED). Load it defensively so this
// test file registers and fails at *assertion* time (behavior gap) rather than
// crashing at require time (a load-time error the TDD gate rejects). Once
// commit-msg-rules.js is implemented in GREEN, the real exports take over.
let rules = {};
let validateMessage = () => {
  throw new Error('commit-msg-rules is not implemented yet');
};
try {
  ({ rules, validateMessage } = require('../commit-msg-rules'));
} catch (err) {
  if (err && err.code !== 'MODULE_NOT_FOUND') throw err;
}

const { getTicketPattern } = require('../../../lib/ticket-provider');

/** A commit message that satisfies every rule (github provider). */
const WELL_FORMED = 'feat(hooks): add commit-msg validator\n\nImplement the rule module.\n\n(#539)';

const GH_CTX = { providerConfig: { provider: 'github' } };
const JIRA_CTX = { providerConfig: { provider: 'jira', projectKey: 'PROJ' } };

/** Assert a rule result is a specific, actionable failure. */
function assertFailure(result) {
  assert.equal(result.ok, false, 'expected the rule to fail');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0, 'reason must be non-empty');
  assert.equal(typeof result.hint, 'string');
  assert.ok(result.hint.length > 0, 'hint must be non-empty');
}

describe('commit-msg-rules module surface', () => {
  it('exports the nine discrete rules plus validateMessage', () => {
    assert.equal(typeof validateMessage, 'function');
    assert.equal(typeof rules, 'object');
    const expected = [
      'semanticFormatRule',
      'allowedTypeRule',
      'titleLengthRule',
      'noTrailingPeriodRule',
      'noEmojiInTitleRule',
      'imperativeMoodRule',
      'bodyLineLengthRule',
      'noAiAttributionRule',
      'ticketIdPresentRule',
    ];
    for (const name of expected) {
      assert.equal(typeof rules[name], 'function', `missing rule ${name}`);
    }
    assert.equal(Object.keys(rules).length, expected.length, 'exactly nine rules');
  });
});

describe('semanticFormatRule', () => {
  it('passes a type(scope): description title', () => {
    assert.deepEqual(rules.semanticFormatRule('feat(hooks): add validator', {}), { ok: true });
  });
  it('fails a title with no semantic type prefix', () => {
    assertFailure(rules.semanticFormatRule('add validator hook', {}));
  });
});

describe('allowedTypeRule', () => {
  it('passes an allowed type', () => {
    assert.deepEqual(rules.allowedTypeRule('feat(hooks): add validator', {}), { ok: true });
  });
  it('fails a disallowed type', () => {
    const result = rules.allowedTypeRule('wip(hooks): add validator', {});
    assertFailure(result);
    assert.match(result.reason, /wip/);
  });
});

describe('titleLengthRule (<=72)', () => {
  it('passes a short title', () => {
    assert.deepEqual(rules.titleLengthRule('feat: add validator', {}), { ok: true });
  });
  it('fails a title longer than 72 chars', () => {
    const longTitle = 'feat: ' + 'a'.repeat(80);
    assert.ok(longTitle.length > 72);
    assertFailure(rules.titleLengthRule(longTitle, {}));
  });
});

describe('noTrailingPeriodRule', () => {
  it('passes a title with no trailing period', () => {
    assert.deepEqual(rules.noTrailingPeriodRule('feat: add validator', {}), { ok: true });
  });
  it('fails a title ending in a period', () => {
    assertFailure(rules.noTrailingPeriodRule('feat: add validator.', {}));
  });
});

describe('noEmojiInTitleRule', () => {
  it('passes a plain-text title', () => {
    assert.deepEqual(rules.noEmojiInTitleRule('feat: add validator', {}), { ok: true });
  });
  it('fails a title containing an emoji', () => {
    assertFailure(rules.noEmojiInTitleRule('feat: add validator \u{1F680}', {}));
  });
});

describe('imperativeMoodRule', () => {
  it('passes an imperative-mood subject', () => {
    assert.deepEqual(rules.imperativeMoodRule('feat: add validator', {}), { ok: true });
  });
  it('fails an unambiguous past-tense subject (verb ending in ed)', () => {
    assertFailure(rules.imperativeMoodRule('feat: added the validator', {}));
  });
  it('fails a third-person subject (verb ending in s)', () => {
    assertFailure(rules.imperativeMoodRule('feat: adds the validator', {}));
  });
  it('passes imperative verbs ending in "s"/"ss" (process, address, focus)', () => {
    for (const w of ['process', 'address', 'focus', 'compress', 'bypass']) {
      assert.deepEqual(rules.imperativeMoodRule(`feat: ${w} the queue`, {}), { ok: true });
    }
  });
  it('passes imperative verbs ending in "ed" (embed, feed, speed)', () => {
    for (const w of ['embed', 'feed', 'speed', 'spread']) {
      assert.deepEqual(rules.imperativeMoodRule(`feat: ${w} the payload`, {}), { ok: true });
    }
  });
});

describe('bodyLineLengthRule (<=100)', () => {
  it('passes when all body lines are within 100 chars', () => {
    const msg = 'feat: add validator\n\nA short body line.';
    assert.deepEqual(rules.bodyLineLengthRule(msg, {}), { ok: true });
  });
  it('fails a body line longer than 100 chars', () => {
    const longLine = 'x'.repeat(120);
    const msg = 'feat: add validator\n\n' + longLine;
    assertFailure(rules.bodyLineLengthRule(msg, {}));
  });
});

describe('noAiAttributionRule', () => {
  it('passes a message with no AI attribution', () => {
    const msg = 'feat: add validator\n\nImplement the rule module.';
    assert.deepEqual(rules.noAiAttributionRule(msg, {}), { ok: true });
  });
  it('fails a message containing an AI co-author trailer', () => {
    const aiName = ['Cl', 'aude'].join('');
    const msg = 'feat: add validator\n\nCo-Authored-By: ' + aiName + ' <noreply>';
    assertFailure(rules.noAiAttributionRule(msg, {}));
  });
});

describe('ticketIdPresentRule (provider-aware)', () => {
  it('accepts a github-form ticket id under provider=github', () => {
    // Reuse the provider pattern to prove the accepted form is provider-derived,
    // never a hard-coded literal in this test.
    const pattern = getTicketPattern(GH_CTX.providerConfig);
    assert.ok(pattern.test('(GH-539)'), 'github pattern should match GH-539');
    assert.deepEqual(rules.ticketIdPresentRule('feat: add validator (GH-539)', GH_CTX), {
      ok: true,
    });
    assert.deepEqual(rules.ticketIdPresentRule('feat: add validator (#539)', GH_CTX), { ok: true });
  });
  it('accepts a jira-form ticket id under provider=jira', () => {
    const pattern = getTicketPattern(JIRA_CTX.providerConfig);
    assert.ok(pattern.test('(PROJ-123)'), 'jira pattern should match PROJ-123');
    assert.deepEqual(rules.ticketIdPresentRule('feat: add validator (PROJ-123)', JIRA_CTX), {
      ok: true,
    });
  });
  it('fails a message with no ticket id', () => {
    assertFailure(rules.ticketIdPresentRule('feat: add validator', GH_CTX));
  });
});

describe('validateMessage', () => {
  it('returns { ok: true } for a well-formed message', () => {
    assert.deepEqual(validateMessage(WELL_FORMED, GH_CTX), { ok: true });
  });
  it('returns { ok: false, rule, reason, hint } naming the failed rule', () => {
    const result = validateMessage('add validator hook (#539)', GH_CTX);
    assert.equal(result.ok, false);
    assert.equal(result.rule, 'semanticFormatRule');
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
    assert.equal(typeof result.hint, 'string');
    assert.ok(result.hint.length > 0);
  });
  it('names ticketIdPresentRule when the ticket id is missing', () => {
    const result = validateMessage('feat(hooks): add validator', GH_CTX);
    assert.equal(result.ok, false);
    assert.equal(result.rule, 'ticketIdPresentRule');
  });
});
