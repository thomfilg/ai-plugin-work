const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SPEC_WRITER_PATH = path.join(__dirname, '..', 'spec-writer.md');

describe('spec-writer.md GREP regex guidance', () => {
  const content = fs.readFileSync(SPEC_WRITER_PATH, 'utf8');

  it('contains guidance to use /regex/flags syntax for GREP markers', () => {
    // Must mention regex syntax in the context of GREP markers
    assert.match(content, /GREP.*regex|regex.*GREP/is,
      'spec-writer.md must contain guidance linking GREP markers to regex syntax');
  });

  it('explains why regex is preferred over literal strings', () => {
    // Must explain resilience to semantically equivalent implementations
    assert.match(content, /resilien|equivalent\s+implementation|brittle|fragile|literal.*break|break.*literal/i,
      'spec-writer.md must explain why regex is preferred (resilience to equivalent implementations)');
  });

  it('includes at least one example showing a regex GREP pattern with /regex/ syntax', () => {
    // Must show a concrete example like: GREP path /someRegex/
    assert.match(content, /GREP\s+\S+\s+\/[^/]+\//,
      'spec-writer.md must include at least one example GREP pattern using /regex/ syntax');
  });

  it('mentions avoiding exact literal strings in GREP markers', () => {
    assert.match(content, /avoid.*literal|prefer.*regex|instead of.*literal|not.*exact.*string|don.t.*literal/i,
      'spec-writer.md must advise against using exact literal strings in GREP markers');
  });
});
