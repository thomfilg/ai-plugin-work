'use strict';

/**
 * Generic RuleEngine shell.
 *
 * Rules are objects with shape:
 *   { id: string, defaultThreshold: number, check(filePath, source) -> Array<{ line, message }> }
 *
 * `run({ files, allowlist })` invokes every registered rule against every file.
 * Files whose path appears in the `allowlist` Set still have rules executed
 * against them, but resulting violations are downgraded from 'error' to 'warning'.
 */
class RuleEngine {
  constructor() {
    this._rules = [];
  }

  register(rule) {
    if (!rule || typeof rule.id !== 'string' || typeof rule.check !== 'function') {
      throw new TypeError('RuleEngine.register: rule must have { id, check }');
    }
    this._rules.push(rule);
  }

  run({ files, allowlist }) {
    const list = files || [];
    const allow = allowlist instanceof Set ? allowlist : new Set();
    const violations = [];

    for (const file of list) {
      const isAllowed = allow.has(file.path);
      for (const rule of this._rules) {
        const findings = rule.check(file.path, file.source) || [];
        for (const f of findings) {
          violations.push({
            file: file.path,
            line: f.line,
            rule: rule.id,
            severity: isAllowed ? 'warning' : 'error',
            message: f.message,
          });
        }
      }
    }

    // Batch-scope rules: if a rule exposes `checkAll(files)`, give it the whole
    // batch. Used by cross-file rules (e.g. duplicate-blocks). Backward
    // compatible: rules without `checkAll` are unaffected.
    for (const rule of this._rules) {
      if (typeof rule.checkAll !== 'function') continue;
      const batchFindings = rule.checkAll(list) || [];
      for (const f of batchFindings) {
        const filePath = f.file;
        const isAllowed = allow.has(filePath);
        violations.push({
          file: filePath,
          line: f.line,
          rule: f.rule || rule.id,
          severity: isAllowed ? 'warning' : 'error',
          message: f.message,
        });
      }
    }

    return { violations };
  }
}

module.exports = { RuleEngine };
