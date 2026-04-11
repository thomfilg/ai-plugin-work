/**
 * Tests for workflows/work/lib/open-questions.js
 *
 * Pure-logic parser module that reads brief.md Open Questions and extracts
 * structured blocks (scope, rationale, resolved).
 *
 * Run: node --test workflows/work/lib/__tests__/open-questions.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  parse,
  findBlocking,
  classify,
  SCOPES,
  downgradeToLocal,
  applyResolutions,
  escapeResolution,
} = require('../open-questions');

// ─── Fixtures ───────────────────────────────────────────────────────────────

const FIXTURE_SINGLE_STRUCTURED = `# Product Brief

## Summary
Example brief.

## Open Questions

- **Question:** Should the gate be a hook or a step?
  - \`scope: architectural\`
  - \`rationale: affects workflow shape\`
  - \`resolved: false\`
`;

const FIXTURE_MULTIPLE_MIXED = `# Brief

## Open Questions

- **Question:** Where should the gate live?
  - \`scope: local\`
  - \`rationale: implementation detail\`
  - \`resolved: false\`
- **Question:** How do siblings coordinate router ownership?
  - \`scope: cross-ticket\`
  - \`rationale: affects multiple tickets\`
  - \`resolved: false\`
- **Question:** Should we migrate to a new framework?
  - \`scope: architectural\`
  - \`rationale: structural change\`
  - \`resolved: true\`
  - **Resolution:** No, defer to Q3 planning.

## Success Metrics
- Some metric.
`;

const FIXTURE_LEGACY_FREE_TEXT = `# Brief

## Open Questions
- Is the API rate limit 100 or 1000?
- Should we use Redis or Memcached?

## Out of Scope
- Nothing here.
`;

const FIXTURE_MALFORMED = `# Brief

## Open Questions

- **Question:** Broken question with no scope
  - \`rationale: missing scope field\`
  - \`resolved: false\`
`;

const FIXTURE_EMPTY_SECTION = `# Brief

## Open Questions

## Out of Scope
- Done.
`;

const FIXTURE_NO_SECTION = `# Brief

## Summary
Nothing to question here.

## Out of Scope
- Done.
`;

const FIXTURE_H1_AFTER_SECTION = `# Brief

## Open Questions

- **Question:** A real question
  - \`scope: architectural\`
  - \`rationale: r\`
  - \`resolved: false\`

# Second H1 Heading

- Not a question, should not be parsed
- Another stray bullet
`;

const FIXTURE_H3_AFTER_SECTION = `# Brief

## Open Questions

- **Question:** A real question
  - \`scope: architectural\`
  - \`rationale: r\`
  - \`resolved: false\`

### Sub Heading Inside Doc

- Not a question
`;

const FIXTURE_MISSING_RESOLVED = `# Brief

## Open Questions

- **Question:** Structured block without resolved field
  - \`scope: architectural\`
  - \`rationale: author forgot resolved\`
`;

// ─── parse() ────────────────────────────────────────────────────────────────

describe('open-questions: parse', () => {
  it('parses a single well-formed structured block', () => {
    const result = parse(FIXTURE_SINGLE_STRUCTURED);
    assert.equal(result.length, 1);
    const q = result[0];
    assert.equal(q.questionText, 'Should the gate be a hook or a step?');
    assert.equal(q.scope, 'architectural');
    assert.equal(q.rationale, 'affects workflow shape');
    assert.equal(q.resolved, false);
    assert.equal(typeof q.startLine, 'number');
    assert.equal(typeof q.endLine, 'number');
    assert.ok(q.endLine >= q.startLine);
  });

  it('parses multiple structured blocks with mixed scopes and resolutions', () => {
    const result = parse(FIXTURE_MULTIPLE_MIXED);
    assert.equal(result.length, 3);

    assert.equal(result[0].scope, 'local');
    assert.equal(result[0].resolved, false);
    assert.equal(result[0].questionText, 'Where should the gate live?');

    assert.equal(result[1].scope, 'cross-ticket');
    assert.equal(result[1].resolved, false);

    assert.equal(result[2].scope, 'architectural');
    assert.equal(result[2].resolved, true);
    assert.equal(result[2].resolution, 'No, defer to Q3 planning.');
  });

  it('does not bleed past the Open Questions section into the next heading', () => {
    const result = parse(FIXTURE_MULTIPLE_MIXED);
    // All blocks must end before the "## Success Metrics" line
    const sectionEndLine = FIXTURE_MULTIPLE_MIXED.split('\n').findIndex((l) =>
      l.startsWith('## Success Metrics')
    );
    for (const q of result) {
      assert.ok(q.endLine < sectionEndLine, `question ending at ${q.endLine} bled past section`);
    }
  });

  it('coerces legacy free-text bullets to { scope: local, resolved: true }', () => {
    const result = parse(FIXTURE_LEGACY_FREE_TEXT);
    assert.equal(result.length, 2);
    for (const q of result) {
      assert.equal(q.scope, 'local');
      assert.equal(q.resolved, true);
    }
    assert.equal(result[0].questionText, 'Is the API rate limit 100 or 1000?');
    assert.equal(result[1].questionText, 'Should we use Redis or Memcached?');
  });

  it('coerces malformed structured blocks (missing scope:) to { scope: local, resolved: true }', () => {
    const result = parse(FIXTURE_MALFORMED);
    assert.equal(result.length, 1);
    assert.equal(result[0].scope, 'local');
    assert.equal(result[0].resolved, true);
  });

  it('returns [] for a brief with no Open Questions section', () => {
    assert.deepEqual(parse(FIXTURE_NO_SECTION), []);
  });

  it('returns [] for an empty Open Questions section', () => {
    assert.deepEqual(parse(FIXTURE_EMPTY_SECTION), []);
  });

  it('returns [] for empty string input', () => {
    assert.deepEqual(parse(''), []);
  });

  it('does not crash on null/undefined input', () => {
    assert.deepEqual(parse(null), []);
    assert.deepEqual(parse(undefined), []);
  });

  it('does not bleed past an h1 heading that follows the section', () => {
    const result = parse(FIXTURE_H1_AFTER_SECTION);
    assert.equal(result.length, 1);
    assert.equal(result[0].questionText, 'A real question');
  });

  it('does not bleed past an h3 heading that follows the section', () => {
    const result = parse(FIXTURE_H3_AFTER_SECTION);
    assert.equal(result.length, 1);
    assert.equal(result[0].questionText, 'A real question');
  });

  it('endLine points to the last non-blank content line of each block', () => {
    const result = parse(FIXTURE_MULTIPLE_MIXED);
    const lines = FIXTURE_MULTIPLE_MIXED.split('\n');
    for (const q of result) {
      assert.notEqual(
        lines[q.endLine].trim(),
        '',
        `endLine ${q.endLine} is blank: "${lines[q.endLine]}"`
      );
    }
  });

  it('endLine for a block with trailing blank before next block lands on last subfield', () => {
    // FIXTURE_MULTIPLE_MIXED has three structured blocks. The first block's
    // last non-blank content line is `  - \`resolved: false\``. We assert
    // that the first question's endLine matches that line, not a blank.
    const result = parse(FIXTURE_MULTIPLE_MIXED);
    const lines = FIXTURE_MULTIPLE_MIXED.split('\n');
    assert.ok(lines[result[0].endLine].includes('resolved: false'));
  });

  it('treats a missing resolved: field as resolved: false on a valid structured block', () => {
    const result = parse(FIXTURE_MISSING_RESOLVED);
    assert.equal(result.length, 1);
    assert.equal(result[0].scope, 'architectural');
    assert.equal(result[0].resolved, false);
    assert.equal(result[0].rationale, 'author forgot resolved');
  });
});

// ─── findBlocking() ─────────────────────────────────────────────────────────

describe('open-questions: findBlocking', () => {
  it('returns an empty array for empty input', () => {
    assert.deepEqual(findBlocking([]), []);
  });

  it('returns an empty array when all questions are local', () => {
    const qs = [
      { scope: 'local', resolved: false },
      { scope: 'local', resolved: false },
    ];
    assert.deepEqual(findBlocking(qs), []);
  });

  it('filters out resolved architectural questions', () => {
    const qs = [
      { scope: 'architectural', resolved: true, questionText: 'a' },
      { scope: 'architectural', resolved: false, questionText: 'b' },
    ];
    const result = findBlocking(qs);
    assert.equal(result.length, 1);
    assert.equal(result[0].questionText, 'b');
  });

  it('returns both unresolved cross-ticket and architectural questions', () => {
    const qs = [
      { scope: 'local', resolved: false, questionText: 'a' },
      { scope: 'cross-ticket', resolved: false, questionText: 'b' },
      { scope: 'architectural', resolved: false, questionText: 'c' },
      { scope: 'architectural', resolved: true, questionText: 'd' },
    ];
    const result = findBlocking(qs);
    assert.equal(result.length, 2);
    assert.deepEqual(
      result.map((q) => q.questionText),
      ['b', 'c']
    );
  });

  it('returns empty when all architectural questions are resolved', () => {
    const qs = [
      { scope: 'architectural', resolved: true },
      { scope: 'architectural', resolved: true },
    ];
    assert.deepEqual(findBlocking(qs), []);
  });
});

// ─── classify() ─────────────────────────────────────────────────────────────

describe('open-questions: classify', () => {
  it('passes through valid scopes', () => {
    assert.equal(classify('local'), 'local');
    assert.equal(classify('cross-ticket'), 'cross-ticket');
    assert.equal(classify('architectural'), 'architectural');
  });

  it('normalizes whitespace and case', () => {
    assert.equal(classify('  local  '), 'local');
    assert.equal(classify('LOCAL'), 'local');
    assert.equal(classify('Cross-Ticket'), 'cross-ticket');
    assert.equal(classify('ARCHITECTURAL'), 'architectural');
  });

  it('returns unknown for invalid scope strings', () => {
    assert.equal(classify('global'), 'unknown');
    assert.equal(classify('system-wide'), 'unknown');
  });

  it('returns unknown for empty or missing input', () => {
    assert.equal(classify(''), 'unknown');
    assert.equal(classify('   '), 'unknown');
    assert.equal(classify(undefined), 'unknown');
    assert.equal(classify(null), 'unknown');
  });

  it('exports a frozen SCOPES allowlist', () => {
    assert.ok(Array.isArray(SCOPES));
    assert.ok(Object.isFrozen(SCOPES));
    assert.deepEqual([...SCOPES].sort(), ['architectural', 'cross-ticket', 'local']);
  });
});

// ─── downgradeToLocal() P1 extension point ──────────────────────────────────

describe('open-questions: downgradeToLocal (P1 extension point)', () => {
  it('is exported as a function', () => {
    assert.equal(typeof downgradeToLocal, 'function');
  });

  it('throws a "not implemented" error indicating P1 status', () => {
    assert.throws(
      () => downgradeToLocal('some question', 'some justification'),
      /not implemented|P1/i
    );
  });
});

// ─── applyResolutions() ─────────────────────────────────────────────────────

describe('open-questions: applyResolutions', () => {
  it('is exported as a function', () => {
    assert.equal(typeof applyResolutions, 'function');
  });

  it('rewrites a single unresolved architectural block with resolved: true and a Resolution line', () => {
    const resolutions = new Map([
      ['Should the gate be a hook or a step?', 'It should be a step.'],
    ]);
    const result = applyResolutions(FIXTURE_SINGLE_STRUCTURED, resolutions);

    // The result is still a string containing the original heading and summary.
    assert.equal(typeof result, 'string');
    assert.ok(result.includes('# Product Brief'));
    assert.ok(result.includes('## Summary'));

    // Re-parse to verify the block is now resolved with the new resolution.
    const parsed = parse(result);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].resolved, true);
    assert.equal(parsed[0].resolution, 'It should be a step.');
  });

  it('rewrites only answered blocks in a multi-block brief', () => {
    const resolutions = new Map([
      ['How do siblings coordinate router ownership?', 'Via a shared registry.'],
    ]);
    const result = applyResolutions(FIXTURE_MULTIPLE_MIXED, resolutions);
    const parsed = parse(result);

    // Still 3 blocks, and only the cross-ticket one was updated.
    assert.equal(parsed.length, 3);

    // Block 0: local, unresolved, untouched
    assert.equal(parsed[0].scope, 'local');
    assert.equal(parsed[0].resolved, false);
    assert.equal(parsed[0].resolution, undefined);

    // Block 1: cross-ticket, now resolved
    assert.equal(parsed[1].scope, 'cross-ticket');
    assert.equal(parsed[1].resolved, true);
    assert.equal(parsed[1].resolution, 'Via a shared registry.');

    // Block 2: architectural, already resolved, untouched
    assert.equal(parsed[2].scope, 'architectural');
    assert.equal(parsed[2].resolved, true);
    assert.equal(parsed[2].resolution, 'No, defer to Q3 planning.');
  });

  it('accepts a plain object (not just a Map) for resolutions', () => {
    const resolutions = {
      'Should the gate be a hook or a step?': 'It should be a step.',
    };
    const result = applyResolutions(FIXTURE_SINGLE_STRUCTURED, resolutions);
    const parsed = parse(result);
    assert.equal(parsed[0].resolved, true);
    assert.equal(parsed[0].resolution, 'It should be a step.');
  });

  it('is a no-op when the question text is not found', () => {
    const resolutions = new Map([['Nonexistent question?', 'unused']]);
    const result = applyResolutions(FIXTURE_SINGLE_STRUCTURED, resolutions);
    assert.equal(result, FIXTURE_SINGLE_STRUCTURED);
  });

  it('is a no-op when resolutions is empty', () => {
    assert.equal(applyResolutions(FIXTURE_SINGLE_STRUCTURED, new Map()), FIXTURE_SINGLE_STRUCTURED);
    assert.equal(applyResolutions(FIXTURE_SINGLE_STRUCTURED, {}), FIXTURE_SINGLE_STRUCTURED);
  });

  it('does not touch blocks that are already resolved (guard)', () => {
    // Run once to resolve the single block.
    const first = applyResolutions(
      FIXTURE_SINGLE_STRUCTURED,
      new Map([['Should the gate be a hook or a step?', 'First answer.']])
    );
    // Attempt to re-resolve with a different answer — should be a no-op
    // because the block is already resolved.
    const second = applyResolutions(
      first,
      new Map([['Should the gate be a hook or a step?', 'Second answer.']])
    );
    assert.equal(second, first);
    const parsed = parse(second);
    assert.equal(parsed[0].resolution, 'First answer.');
  });

  it('is idempotent: running twice with the same resolutions produces byte-equal output', () => {
    const resolutions = new Map([
      ['How do siblings coordinate router ownership?', 'Via a shared registry.'],
      ['Where should the gate live?', 'In the work steps directory.'],
    ]);
    const once = applyResolutions(FIXTURE_MULTIPLE_MIXED, resolutions);
    const twice = applyResolutions(once, resolutions);
    assert.equal(twice, once);
  });

  it('preserves the Question[] count after a rewrite (no block corruption)', () => {
    const before = parse(FIXTURE_MULTIPLE_MIXED).length;
    const resolutions = new Map([
      ['How do siblings coordinate router ownership?', 'answer'],
    ]);
    const after = parse(applyResolutions(FIXTURE_MULTIPLE_MIXED, resolutions)).length;
    assert.equal(after, before);
  });

  it('preserves surrounding markdown byte-for-byte outside the changed block', () => {
    const resolutions = new Map([
      ['Should the gate be a hook or a step?', 'A step.'],
    ]);
    const result = applyResolutions(FIXTURE_SINGLE_STRUCTURED, resolutions);
    // Heading, summary, and section header are unchanged verbatim.
    assert.ok(result.startsWith('# Product Brief\n\n## Summary\nExample brief.\n\n## Open Questions\n'));
  });

  it('escapes injection: leading "##" heading in answer does not create a new section', () => {
    const malicious = '## Injected Heading\nmore stuff';
    const resolutions = new Map([
      ['Should the gate be a hook or a step?', malicious],
    ]);
    const result = applyResolutions(FIXTURE_SINGLE_STRUCTURED, resolutions);

    // Re-parse: still exactly one question, resolved.
    const parsed = parse(result);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].resolved, true);

    // The leading '#' characters must have been stripped so no new heading
    // is introduced into the document.
    assert.ok(!/^##\s+Injected Heading/m.test(result));
  });

  it('collapses multi-line answers to a single line', () => {
    const multi = 'line one\nline two\nline three';
    const resolutions = new Map([
      ['Should the gate be a hook or a step?', multi],
    ]);
    const result = applyResolutions(FIXTURE_SINGLE_STRUCTURED, resolutions);
    const parsed = parse(result);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].resolved, true);
    // The stored resolution must not contain a literal newline.
    assert.ok(parsed[0].resolution && !parsed[0].resolution.includes('\n'));
    assert.ok(parsed[0].resolution.includes('line one'));
    assert.ok(parsed[0].resolution.includes('line two'));
  });

  it('returns the input unchanged when markdown has no Open Questions section', () => {
    const resolutions = new Map([['x', 'y']]);
    assert.equal(applyResolutions(FIXTURE_NO_SECTION, resolutions), FIXTURE_NO_SECTION);
  });

  it('is a no-op when the answer collapses to empty after escaping (e.g. pure-hash input)', () => {
    // `escapeResolution('###')` strips all leading `#` characters and
    // returns `''`. An empty-after-escape answer must not produce a
    // dangling `- **Resolution:** ` line with empty content — the block
    // should remain unresolved so the gate re-prompts on the next pass.
    const resolutions = new Map([
      ['Should the gate be a hook or a step?', '###'],
    ]);
    const result = applyResolutions(FIXTURE_SINGLE_STRUCTURED, resolutions);

    // Byte-equal to the input: no rewrite occurred.
    assert.equal(result, FIXTURE_SINGLE_STRUCTURED);

    // And re-parsing confirms the block is still unresolved with no
    // `resolution` field (i.e., `undefined`, not an empty string).
    const parsed = parse(result);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].resolved, false);
    assert.equal(parsed[0].resolution, undefined);
  });

  it('inserts resolved: true when the block has no resolved: subfield', () => {
    // FIXTURE_MISSING_RESOLVED has `scope: architectural` and `rationale:`
    // but NO `resolved:` subfield. The parser defaults to resolved: false.
    // applyResolutions must insert a `resolved: true` line (not just flip
    // an existing one) AND append the Resolution line.
    const resolutions = new Map([
      ['Structured block without resolved field', 'Resolved by inserting the subfield.'],
    ]);
    const result = applyResolutions(FIXTURE_MISSING_RESOLVED, resolutions);
    const parsed = parse(result);

    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].resolved, true, 'block must be resolved after applyResolutions');
    assert.equal(
      parsed[0].resolution,
      'Resolved by inserting the subfield.',
      'resolution text must be set'
    );

    // GH-215: Verify raw line ordering — `resolved: true` must appear
    // BEFORE the `**Resolution:**` line, not after it.
    const lines = result.split('\n');
    const resolvedIdx = lines.findIndex((l) => l.includes('`resolved: true`'));
    const resolutionIdx = lines.findIndex((l) => l.includes('**Resolution:**'));
    assert.ok(resolvedIdx !== -1, 'resolved: true line must exist');
    assert.ok(resolutionIdx !== -1, 'Resolution line must exist');
    assert.ok(
      resolvedIdx < resolutionIdx,
      `resolved: true (line ${resolvedIdx}) must come before **Resolution:** (line ${resolutionIdx})`
    );
  });

  it('is a no-op when the answer is pure whitespace that collapses to empty', () => {
    // `escapeResolution('## ')` also returns `''`; same contract applies.
    const resolutions = new Map([
      ['Should the gate be a hook or a step?', '## '],
    ]);
    const result = applyResolutions(FIXTURE_SINGLE_STRUCTURED, resolutions);
    assert.equal(result, FIXTURE_SINGLE_STRUCTURED);
  });
});

// ─── escapeResolution() ─────────────────────────────────────────────────────

describe('open-questions: escapeResolution', () => {
  it('is exported as a function', () => {
    assert.equal(typeof escapeResolution, 'function');
  });

  it('returns an empty string for empty/nullish input', () => {
    assert.equal(escapeResolution(''), '');
    assert.equal(escapeResolution(null), '');
    assert.equal(escapeResolution(undefined), '');
  });

  it('strips leading "#" characters so answers cannot start a new heading', () => {
    assert.ok(!escapeResolution('## Heading').startsWith('#'));
    assert.ok(!escapeResolution('# Top Heading').startsWith('#'));
    assert.ok(!escapeResolution('#### Deep Heading').startsWith('#'));
  });

  it('collapses embedded newlines to spaces', () => {
    const out = escapeResolution('line one\nline two\r\nline three');
    assert.ok(!out.includes('\n'));
    assert.ok(!out.includes('\r'));
    assert.ok(out.includes('line one'));
    assert.ok(out.includes('line two'));
    assert.ok(out.includes('line three'));
  });

  it('leaves a clean single-line answer untouched', () => {
    assert.equal(escapeResolution('A simple answer.'), 'A simple answer.');
  });

  it('neutralizes inline triple-backticks so they cannot terminate a fence', () => {
    const out = escapeResolution('```js\nconst x = 1;\n```');
    assert.ok(!out.includes('```'));
  });

  it('trims surrounding whitespace', () => {
    assert.equal(escapeResolution('   hello   '), 'hello');
  });

  it('returns an empty string for pure-hash / markdown-control-only input', () => {
    // An answer consisting only of heading markers has no content left
    // after leading-# stripping and whitespace trim. This is the input
    // shape that motivates the `applyResolutions` no-op guard.
    assert.equal(escapeResolution('###'), '');
    assert.equal(escapeResolution('## '), '');
    assert.equal(escapeResolution('#'), '');
    assert.equal(escapeResolution('   ##   '), '');
  });
});
