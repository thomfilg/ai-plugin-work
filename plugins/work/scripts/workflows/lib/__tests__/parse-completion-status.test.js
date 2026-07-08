/**
 * Tests for parse-completion-status.js
 *
 * Run: node --test ./scripts/workflows/lib/__tests__/parse-completion-status.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildVerdictRegex, hasVerdict } = require('../parse-completion-status');

describe('parse-completion-status — buildVerdictRegex', () => {
  const completeOrApproved = buildVerdictRegex(['COMPLETE', 'APPROVED']);
  const approvedOnly = buildVerdictRegex(['APPROVED']);

  it('matches canonical writer output `## Final Status\\n\\n**[COMPLETE]**`', () => {
    const md = `# Completion Verification\n\n## Final Status\n\n**[COMPLETE]** - All requirements have been delivered.\n`;
    assert.match(md, completeOrApproved);
    assert.equal(hasVerdict(md, ['COMPLETE']), true);
  });

  it('matches agent template `### Final Status:\\n[COMPLETE]`', () => {
    const md = `### Final Status:\n[COMPLETE]\n`;
    assert.match(md, completeOrApproved);
  });

  it('matches legacy plain `Status: APPROVED`', () => {
    assert.match('Status: APPROVED', approvedOnly);
    assert.match('Status: COMPLETE', completeOrApproved);
  });

  it('matches reviewer alt form `**Verdict:** **[APPROVED]**`', () => {
    assert.match('**Verdict:** **[APPROVED]**', approvedOnly);
  });

  it('matches the actual ECHO-4630 verdict block (bug repro)', () => {
    const md = [
      '# Completion Verification — ECHO-4630',
      '',
      '**Verdict:** **[COMPLETE]**',
      '',
      '## Final Status',
      '**[COMPLETE]** — All in-scope P0/P1 requirements have code evidence.',
    ].join('\n');
    assert.match(md, completeOrApproved);
    assert.equal(hasVerdict(md, ['COMPLETE']), true);
  });

  it('rejects INCOMPLETE / NEEDS_WORK', () => {
    assert.doesNotMatch('## Final Status\n\n**[INCOMPLETE]**', completeOrApproved);
    assert.doesNotMatch('Status: NEEDS_WORK', approvedOnly);
  });

  it('is anchored — random prose containing "Status" + later "[COMPLETE]" with non-formatting text in between does not match', () => {
    // Between "Status" and "COMPLETE" there is alphabetic prose, breaking the
    // formatting-only inter-character class.
    const md = 'Status was reviewed by the team. They concluded the work was COMPLETE.';
    assert.doesNotMatch(md, completeOrApproved);
  });

  it('hasVerdict handles non-string / empty inputs safely', () => {
    assert.equal(hasVerdict('', ['COMPLETE']), false);
    assert.equal(hasVerdict(null, ['COMPLETE']), false);
    assert.equal(hasVerdict(undefined, ['COMPLETE']), false);
  });

  it('throws on empty verdict list', () => {
    assert.throws(() => buildVerdictRegex([]));
    assert.throws(() => buildVerdictRegex(null));
  });
});
