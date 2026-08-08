/**
 * Unit tests for lib/attribution.js — the rule set that decides whether text
 * signs itself as an AI.
 *
 * The load-bearing distinction under test is attribution vs mention: naming a
 * product is normal engineering work (`feat: add <vendor> adapter`), claiming
 * it wrote the change is not (`Co-Authored-By: <tool>`). Tool names are built
 * from fragments here for the same reason the module builds them that way —
 * a fixture that matches the blocklist makes greps over the repo useless.
 *
 * Run with: node --test plugins/ghostwriter/lib/__tests__/attribution.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { checkText, AI_TOOL_NAMES } = require('../attribution');

const TOOL = ['Cl', 'aude'].join('');
const TOOL_ALT = ['Co', 'dex'].join('');
const VENDOR = ['open', 'ai'].join('');

/** Assert a result is a specific, actionable failure. */
function assertBlocked(result, rule) {
  assert.equal(result.ok, false, 'expected the text to be rejected');
  assert.equal(result.rule, rule);
  assert.ok(result.reason && result.reason.length > 0, 'reason must be non-empty');
  assert.ok(result.hint && result.hint.length > 0, 'hint must be non-empty');
  assert.ok(typeof result.evidence === 'string', 'evidence must be a string');
}

describe('attribution vocabulary', () => {
  it('carries no contiguous tool-name literal in its own source', () => {
    // Case-INSENSITIVE, because the rules are: a comment that spells a name
    // with a capital is exactly as self-matching as one that does not, and a
    // case-sensitive assertion here quietly let two through.
    const source = require('node:fs')
      .readFileSync(require.resolve('../attribution.js'), 'utf8')
      .toLowerCase();
    for (const name of AI_TOOL_NAMES) {
      assert.ok(!source.includes(name), `source must not spell "${name}" contiguously`);
    }
  });

  it('excludes names that collide with common words or surnames', () => {
    for (const excluded of ['devin', 'opus', 'sonnet', 'haiku']) {
      assert.ok(!AI_TOOL_NAMES.includes(excluded), `${excluded} is too collision-prone`);
    }
  });
});

describe('checkText — mentions are allowed', () => {
  it('passes an ordinary commit message', () => {
    assert.deepEqual(checkText('feat(hooks): add the guard\n\nCloses #12'), { ok: true });
  });

  it('passes a bare product mention', () => {
    assert.deepEqual(checkText(`feat: add ${VENDOR} adapter (#123)`), { ok: true });
    assert.deepEqual(checkText('fix: handle gemini rate limit (#123)'), { ok: true });
  });

  it('passes a subject that merely starts with a tool name', () => {
    assert.deepEqual(checkText(`${TOOL.toLowerCase()}: retune the prompt (#7)`), { ok: true });
  });

  it('passes a body line whose key merely contains a tool name', () => {
    assert.deepEqual(checkText('fix: keep caret steady\n\ncursor-position: 3'), { ok: true });
  });

  it('passes empty and nullish input', () => {
    assert.deepEqual(checkText(''), { ok: true });
    assert.deepEqual(checkText(null), { ok: true });
    assert.deepEqual(checkText(undefined), { ok: true });
  });
});

describe('checkText — attribution is blocked', () => {
  it('rejects an AI co-author trailer', () => {
    const result = checkText(`feat: x\n\nCo-Authored-By: ${TOOL} <noreply@example.com>`);
    assertBlocked(result, 'aiCoAuthorTrailer');
    assert.ok(result.evidence.startsWith('Co-Authored-By:'));
  });

  it('rejects a sign-off that names a tool', () => {
    assertBlocked(
      checkText(`fix: y\n\nSigned-off-by: ${TOOL_ALT} <bot@example.com>`),
      'aiCoAuthorTrailer'
    );
  });

  it('rejects a "generated with <tool>" footer', () => {
    assertBlocked(checkText(`feat: x\n\nGenerated with ${TOOL} Code`), 'aiGeneratedPhrase');
  });

  it('rejects the emoji + markdown-link footer form', () => {
    const footer = `🤖 Generated with [${TOOL} Code](https://${TOOL.toLowerCase()}.com/${TOOL.toLowerCase()}-code)`;
    assertBlocked(checkText(`feat: x\n\n${footer}`), 'aiGeneratedPhrase');
  });

  it('rejects "written by <tool>" and "created using <tool>"', () => {
    assertBlocked(checkText(`docs: notes\n\nWritten by ${TOOL}.`), 'aiGeneratedPhrase');
    assertBlocked(checkText(`docs: notes\n\nCreated using ${TOOL_ALT}.`), 'aiGeneratedPhrase');
  });

  it('rejects a bare product attribution link', () => {
    const link = `https://${TOOL.toLowerCase()}.ai/code/session_01J3b151ex3`;
    assertBlocked(checkText(`feat: x\n\nSee ${link}`), 'aiAttributionLink');
  });

  it('rejects a tool-named session trailer', () => {
    const trailer = `${TOOL_ALT}-Session: 01J3b151ex3GGxmmS8BsFZua`;
    assertBlocked(checkText(`feat: x\n\n${trailer}`), 'aiSessionTrailer');
  });

  it('reports the offending line as evidence, truncated when huge', () => {
    const padded = 'y'.repeat(400);
    const result = checkText(`feat: x\n\nCo-Authored-By: ${TOOL} ${padded}`);
    assert.equal(result.ok, false);
    assert.ok(result.evidence.length <= 120, `evidence was ${result.evidence.length} chars`);
  });

  it('fires on a raw shell command, not just a tidy message', () => {
    const command = `git commit -m "feat: x\n\nCo-Authored-By: ${TOOL} <a@b>"`;
    assertBlocked(checkText(command), 'aiCoAuthorTrailer');
  });
});

describe('aiAttributionLink — host boundary', () => {
  it('blocks the product footer link', () => {
    assertBlocked(
      checkText(`Generated with [x](https://${VENDOR}.com/${TOOL_ALT})`),
      'aiGeneratedPhrase'
    );
    assertBlocked(
      checkText(`See https://${VENDOR}.com/${TOOL_ALT} for details`),
      'aiAttributionLink'
    );
  });

  it('allows a documentation host that merely contains it', () => {
    // `developers.<vendor>.com/<tool>/plugins` is where the docs live. Citing
    // docs is describing the work; a substring match cannot tell the two apart.
    assert.deepEqual(
      checkText(`- Plugins overview: https://developers.${VENDOR}.com/${TOOL_ALT}/plugins`),
      { ok: true }
    );
  });
});
