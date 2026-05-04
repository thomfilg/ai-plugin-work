#!/usr/bin/env node
/**
 * write-code-review.js — Code Review Report Writer (agent-gated)
 *
 * ONLY callable by: code-checker
 *
 * Accepts JSON via stdin with code review findings, validates, and writes code-review.check.md.
 *
 * Usage (from code-checker agent via Bash):
 *   echo '<json>' | node workflows/check/scripts/write-code-review.js
 *
 * Required JSON fields:
 *   - reportPath: string      — Full path (e.g. .../code-review.check.md)
 *   - changesHash: string     — Git changes hash
 *   - verdict: string         — "Well-Implemented" | "Needs Minor Fixes" | "Needs Major Refactoring" | "Critical Issues"
 *   - strengths: string[]     — List of positive findings
 *   - issues: array           — [{ priority: "critical"|"important"|"nice-to-have", title, file?, line?, description, impact, recommendation }]
 *
 * Optional fields:
 *   - summary: string             — Executive summary
 *   - recommendations: string[]   — General improvement recommendations
 *   - testCoverage: string        — Test coverage analysis section
 *   - filesReviewed: string[]     — List of files reviewed
 */

const { createReportWriter } = require('../../lib/scripts/write-report');

const VALID_VERDICTS = [
  'Well-Implemented',
  'Needs Minor Fixes',
  'Needs Major Refactoring',
  'Critical Issues',
];
const VALID_PRIORITIES = ['critical', 'important', 'nice-to-have'];

const writer = createReportWriter({
  name: 'Code Review Writer',

  reportType: 'codeReview',

  allowedAgents: ['code-checker'],

  requiredFields: ['reportPath', 'changesHash', 'verdict', 'strengths', 'issues'],

  validate(input) {
    const errors = [];

    if (!VALID_VERDICTS.includes(input.verdict)) {
      errors.push(
        `Invalid verdict "${input.verdict}". Must be one of: ${VALID_VERDICTS.join(', ')}`
      );
    }

    if (!Array.isArray(input.strengths) || input.strengths.length === 0) {
      errors.push('At least one strength must be listed');
    }

    if (!Array.isArray(input.issues)) {
      errors.push('issues must be an array');
    } else {
      for (let i = 0; i < input.issues.length; i++) {
        // validate each issue entry
        const issue = input.issues[i];
        if (!issue || typeof issue !== 'object') {
          errors.push(`issues[${i}] must be a non-null object`);
          continue;
        }
        if (!issue.title) errors.push(`issues[${i}].title is required`);
        if (!issue.priority || !VALID_PRIORITIES.includes(issue.priority)) {
          errors.push(`issues[${i}].priority must be one of: ${VALID_PRIORITIES.join(', ')}`);
        }
        if (!issue.description) errors.push(`issues[${i}].description is required`);
      }
    }

    const basename = require('path').basename(input.reportPath || '');
    if (basename !== 'code-review.check.md') {
      errors.push(`reportPath basename must be "code-review.check.md" (got "${basename}")`);
    }

    return errors;
  },

  formatReport(input) {
    const lines = [];
    const timestamp = new Date().toISOString();

    const gateStatus =
      input.verdict === 'Well-Implemented' || input.verdict === 'Needs Minor Fixes'
        ? 'APPROVED'
        : 'NEEDS_WORK';
    lines.push(`**Changes Hash:** ${input.changesHash}`);
    lines.push(`Status: ${gateStatus}`);
    lines.push('');
    lines.push('# Code Review Report');
    lines.push('');
    lines.push(`- **Date:** ${timestamp}`);
    lines.push('');

    // Overall Assessment
    const verdictIcon =
      {
        'Well-Implemented': '✅',
        'Needs Minor Fixes': '⚠️',
        'Needs Major Refactoring': '🔧',
        'Critical Issues': '❌',
      }[input.verdict] || '';

    lines.push('## Overall Assessment');
    lines.push('');
    lines.push(`**${verdictIcon} ${input.verdict}**`);
    lines.push('');

    if (input.summary) {
      lines.push(input.summary);
      lines.push('');
    }

    // Files reviewed
    if (input.filesReviewed && input.filesReviewed.length > 0) {
      lines.push('### Files Reviewed');
      lines.push('');
      for (const f of input.filesReviewed) {
        lines.push(`- \`${f}\``);
      }
      lines.push('');
    }

    // Strengths
    lines.push('## Strengths');
    lines.push('');
    for (const s of input.strengths) {
      lines.push(`- ${s}`);
    }
    lines.push('');

    // Issues
    lines.push('## Issues Found');
    lines.push('');
    const issues = input.issues || [];
    if (issues.length === 0) {
      lines.push('No issues found.');
    } else {
      const priorityIcon = { critical: '🔴', important: '🟡', 'nice-to-have': '🔵' };
      for (const issue of issues) {
        lines.push(
          `**[${priorityIcon[issue.priority] || ''} ${issue.priority.charAt(0).toUpperCase() + issue.priority.slice(1)}] ${issue.title}**`
        );
        if (issue.file) {
          lines.push(`- File: \`${issue.file}${issue.line ? ':' + issue.line : ''}\``);
        }
        lines.push(`- Description: ${issue.description}`);
        if (issue.impact) lines.push(`- Impact: ${issue.impact}`);
        if (issue.recommendation) lines.push(`- Recommendation: ${issue.recommendation}`);
        lines.push('');
      }
    }

    // Recommendations
    if (input.recommendations && input.recommendations.length > 0) {
      lines.push('## Improvement Recommendations');
      lines.push('');
      for (const r of input.recommendations) {
        lines.push(`- ${r}`);
      }
      lines.push('');
    }

    // Test Coverage
    if (input.testCoverage) {
      lines.push('## Test Coverage Analysis');
      lines.push('');
      lines.push(input.testCoverage);
      lines.push('');
    }

    // Final verdict
    lines.push('## Final Verdict');
    lines.push('');
    const criticalCount = issues.filter((i) => i.priority === 'critical').length;
    const importantCount = issues.filter((i) => i.priority === 'important').length;
    lines.push(
      `**${input.verdict}** — ${criticalCount} critical, ${importantCount} important issue(s)`
    );
    lines.push('');

    return lines.join('\n');
  },
});

writer.run().catch((err) => {
  process.stderr.write(`[Code Review Writer] Unexpected error: ${err.message}\n`);
  process.exit(1);
});
