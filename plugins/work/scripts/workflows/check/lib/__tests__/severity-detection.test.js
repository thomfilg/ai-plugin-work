const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { detectSeverityMarkers } = require('../severity-detection');

describe('severity-detection', () => {
  describe('genuine issue detection', () => {
    it('detects a genuine CRITICAL issue', () => {
      const report = '🔴 CRITICAL: Missing input validation in auth handler';
      const result = detectSeverityMarkers(report);
      assert.equal(result.critical.length, 1);
      assert.equal(result.important.length, 0);
    });

    it('detects a genuine IMPORTANT issue', () => {
      const report = '🟡 IMPORTANT: Should add rate limiting';
      const result = detectSeverityMarkers(report);
      assert.equal(result.important.length, 1);
      assert.equal(result.critical.length, 0);
    });

    it('does not detect text-only CRITICAL without emoji marker (emoji convention is enforced standard)', () => {
      const report = 'CRITICAL must fix: do this now';
      const result = detectSeverityMarkers(report);
      assert.equal(result.critical.length, 0);
      assert.equal(result.important.length, 0);
    });

    it('detects multiple severity markers on different lines', () => {
      const report = [
        'Review findings:',
        '🔴 CRITICAL: SQL injection in query builder',
        '🔴 CRITICAL: Hardcoded credentials in config',
        '🟡 IMPORTANT: Missing error handling in API route',
      ].join('\n');
      const result = detectSeverityMarkers(report);
      assert.equal(result.critical.length, 2);
      assert.equal(result.important.length, 1);
    });
  });

  describe('negation context — false positive prevention', () => {
    it('"No remaining" negation does not trigger false positive', () => {
      const report = 'No remaining 🔴 CRITICAL or 🟡 IMPORTANT issues.';
      const result = detectSeverityMarkers(report);
      assert.equal(result.critical.length, 0);
      assert.equal(result.important.length, 0);
    });

    it('"0 CRITICAL" does not trigger false positive', () => {
      const report = '0 🔴 CRITICAL issues found';
      const result = detectSeverityMarkers(report);
      assert.equal(result.critical.length, 0);
    });

    it('"No CRITICAL issues" does not trigger false positive', () => {
      const report = 'No 🔴 CRITICAL issues found';
      const result = detectSeverityMarkers(report);
      assert.equal(result.critical.length, 0);
    });

    it('does not suppress genuine finding when "no...issues" appears mid-line', () => {
      const report = 'there are no blocking issues with 🔴 CRITICAL: the session token expiry';
      const result = detectSeverityMarkers(report);
      assert.equal(
        result.critical.length,
        1,
        'mid-line negation phrase must not suppress genuine finding'
      );
    });

    it('does not suppress genuine finding with "no remaining" in description', () => {
      const report = '🔴 CRITICAL: No remaining input validation after auth refactor';
      const result = detectSeverityMarkers(report);
      assert.equal(
        result.critical.length,
        1,
        '"no remaining" in description must not suppress genuine finding'
      );
    });

    it('does not suppress genuine finding with "none found" in description', () => {
      const report = '🔴 CRITICAL: Security headers - none found in response';
      const result = detectSeverityMarkers(report);
      assert.equal(
        result.critical.length,
        1,
        '"none found" in description must not suppress genuine finding'
      );
    });

    it('does not suppress genuine finding with "all resolved" in description', () => {
      const report = '🔴 CRITICAL: All user sessions resolved to wrong tenant';
      const result = detectSeverityMarkers(report);
      assert.equal(
        result.critical.length,
        1,
        '"all...resolved" in description must not suppress genuine finding'
      );
    });

    it('does not suppress genuine finding with "0 critical" in description', () => {
      const report = '🔴 CRITICAL: Returns 0 critical errors instead of raising exception';
      const result = detectSeverityMarkers(report);
      assert.equal(
        result.critical.length,
        1,
        '"0...critical" in description must not suppress genuine finding'
      );
    });
  });

  describe('Markdown list-prefixed negation — false positive prevention', () => {
    it('suppresses "- No remaining" bullet-list negation', () => {
      const report = '- No remaining 🔴 CRITICAL issues';
      const result = detectSeverityMarkers(report);
      assert.equal(result.critical.length, 0, 'bullet-list negation must be suppressed');
    });

    it('suppresses "* No CRITICAL issues" bullet-list negation', () => {
      const report = '* No 🔴 CRITICAL issues found';
      const result = detectSeverityMarkers(report);
      assert.equal(result.critical.length, 0, 'asterisk-list negation must be suppressed');
    });

    it('suppresses "> All resolved" blockquote negation', () => {
      const report = '> All 🔴 CRITICAL issues resolved';
      const result = detectSeverityMarkers(report);
      assert.equal(result.critical.length, 0, 'blockquote negation must be suppressed');
    });

    it('suppresses indented bullet-list negation', () => {
      const report = '  - 0 🔴 CRITICAL issues found';
      const result = detectSeverityMarkers(report);
      assert.equal(result.critical.length, 0, 'indented bullet negation must be suppressed');
    });

    it('suppresses nested list negation ("> - No...")', () => {
      const report = '> - No 🔴 CRITICAL issues found';
      const result = detectSeverityMarkers(report);
      assert.equal(result.critical.length, 0, 'nested list negation must be suppressed');
    });
  });

  describe('inline code — false positive prevention', () => {
    it('does not detect severity marker inside backtick-quoted code', () => {
      const report =
        "- Evidence: Running `detectSeverityMarkers('no blocking issues with 🔴 CRITICAL: the session token expiry')` returns empty";
      const result = detectSeverityMarkers(report);
      assert.equal(result.critical.length, 0);
    });

    it('still detects marker when it appears outside backticks on the same line', () => {
      const report = '`some code` then 🔴 CRITICAL: real issue here';
      const result = detectSeverityMarkers(report);
      assert.equal(result.critical.length, 1);
    });

    it('does not detect severity marker inside double-quoted string', () => {
      const report =
        'The helper correctly handles "### 🔴 CRITICAL ISSUES" by stripping the prefix.';
      const result = detectSeverityMarkers(report);
      assert.equal(result.critical.length, 0);
    });

    it('still detects marker when it appears outside double quotes on the same line', () => {
      const report = '"some quoted text" then 🔴 CRITICAL: real issue here';
      const result = detectSeverityMarkers(report);
      assert.equal(result.critical.length, 1);
    });
  });

  describe('severity label formatting — real findings in bracket format', () => {
    it('detects real finding in **[🟡 Important]** format', () => {
      const report =
        '**[🟡 Important] Backward-compatibility regression: text-only severity patterns silently dropped**';
      const result = detectSeverityMarkers(report);
      assert.equal(result.important.length, 1);
    });

    it('detects real finding in **[🔴 CRITICAL]** format', () => {
      const report = '**[🔴 CRITICAL] Missing input validation**';
      const result = detectSeverityMarkers(report);
      assert.equal(result.critical.length, 1);
    });

    it('does not detect severity justification lines with emoji', () => {
      const report =
        '- Severity justification: 🟡 Important because the emoji convention is the enforced standard';
      const result = detectSeverityMarkers(report);
      assert.equal(result.important.length, 0);
    });
  });

  describe('mixed content — real issues with negation summary', () => {
    it('counts only real issues, not negation summary lines', () => {
      const lines = [];
      // Pad lines 1-9
      for (let i = 1; i <= 9; i++) lines.push(`Line ${i} normal text`);
      // Line 10: real CRITICAL issue
      lines.push('🔴 CRITICAL: Buffer overflow in parser');
      // Pad lines 11-49
      for (let i = 11; i <= 49; i++) lines.push(`Line ${i} normal text`);
      // Line 50: negation summary
      lines.push('No remaining 🔴 CRITICAL issues');

      const report = lines.join('\n');
      const result = detectSeverityMarkers(report);
      assert.equal(result.critical.length, 1);
      // The match should come from line 10, not line 50
      assert.ok(
        result.critical[0].includes('Buffer overflow'),
        'Match should be the real issue from line 10'
      );
    });
  });

  describe('section headings with severity keywords', () => {
    it('does not count heading when content says "None found"', () => {
      const report = [
        '### 🔴 CRITICAL ISSUES',
        'None found',
        '',
        '### 🟡 IMPORTANT ISSUES',
        'None found',
      ].join('\n');
      const result = detectSeverityMarkers(report);
      assert.equal(result.critical.length, 0);
      assert.equal(result.important.length, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: validateCodeReview uses detectSeverityMarkers (Task 3)
// ---------------------------------------------------------------------------
describe('validateCodeReview integration', () => {
  /** @type {string} */
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'severity-int-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper: write a code-review.check.md and call validateCodeReview.
   * @param {string} content
   */
  function runValidation(content) {
    const { validateCodeReview } = require('../../hooks/check-validate-reports');
    fs.writeFileSync(path.join(tmpDir, 'code-review.check.md'), content, 'utf8');
    return validateCodeReview(tmpDir);
  }

  it('returns hasCritical false for negation-only content', () => {
    const content = [
      '**Changes Hash:** abc123',
      '',
      '## Summary',
      'No remaining 🔴 CRITICAL or 🟡 IMPORTANT issues.',
      '0 🔴 CRITICAL issues found.',
    ].join('\n');

    const result = runValidation(content);

    assert.equal(result.exists, true);
    assert.equal(result.hasCritical, false, 'negation-only content must not flag critical');
    assert.equal(result.hasImportant, false, 'negation-only content must not flag important');
    assert.equal(result.valid, true);
  });

  it('returns hasCritical true for genuine critical issues', () => {
    const content = [
      '**Changes Hash:** abc123',
      '',
      '🔴 CRITICAL: SQL injection vulnerability in query builder',
    ].join('\n');

    const result = runValidation(content);

    assert.equal(result.exists, true);
    assert.equal(result.hasCritical, true);
    assert.equal(result.valid, false);
  });

  it('returns hasImportant true for genuine important issues', () => {
    const content = [
      '**Changes Hash:** abc123',
      '',
      '🟡 IMPORTANT: Should add rate limiting to API',
    ].join('\n');

    const result = runValidation(content);

    assert.equal(result.exists, true);
    assert.equal(result.hasImportant, true);
    assert.equal(result.hasCritical, false);
    assert.equal(result.valid, true);
  });

  it('does not count section heading labels as findings', () => {
    const content = [
      '**Changes Hash:** abc123',
      '',
      '### 🔴 CRITICAL ISSUES',
      'None found',
      '',
      '### 🟡 IMPORTANT ISSUES',
      'None found',
    ].join('\n');

    const result = runValidation(content);

    assert.equal(result.hasCritical, false, 'heading label must not count as critical');
    assert.equal(result.hasImportant, false, 'heading label must not count as important');
    assert.equal(result.valid, true);
  });

  it('is exported via module.exports', () => {
    const mod = require('../../hooks/check-validate-reports');
    assert.equal(typeof mod.validateCodeReview, 'function');
  });
});
