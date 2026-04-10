#!/usr/bin/env node
/**
 * write-completion-report.js — Completion Report Writer (agent-gated)
 *
 * ONLY callable by: completion-checker
 *
 * Accepts JSON via stdin with requirements verification results,
 * validates, and writes completion.check.md.
 *
 * Usage (from completion-checker agent via Bash):
 *   echo '<json>' | node workflows/check/scripts/write-completion-report.js
 *
 * Required JSON fields:
 *   - reportPath: string      — Full path (e.g. .../completion.check.md)
 *   - changesHash: string     — Git changes hash
 *   - originalRequest: string — Summary of what the user asked for
 *   - deliverables: array     — [{ requirement: string, delivered: boolean, description: string }]
 *   - finalStatus: string     — "COMPLETE" | "INCOMPLETE"
 *
 * Optional fields:
 *   - missingItems: string[]  — List of what's still missing (required if INCOMPLETE)
 *   - planningGaps: string[]  — Gaps between planned and delivered
 */

const { createReportWriter } = require('../../lib/scripts/write-report');

const writer = createReportWriter({
  name: 'Completion Report Writer',

  allowedAgents: ['completion-checker'],

  requiredFields: ['reportPath', 'changesHash', 'originalRequest', 'deliverables', 'finalStatus'],

  validate(input) {
    const errors = [];

    if (!['COMPLETE', 'INCOMPLETE'].includes(input.finalStatus)) {
      errors.push(`finalStatus must be "COMPLETE" or "INCOMPLETE" (got "${input.finalStatus}")`);
    }

    if (!Array.isArray(input.deliverables) || input.deliverables.length === 0) {
      errors.push('At least one deliverable must be listed');
    } else {
      for (let i = 0; i < input.deliverables.length; i++) {
        const d = input.deliverables[i];
        if (!d.requirement) errors.push(`deliverables[${i}].requirement is required`);
        if (d.delivered === undefined)
          errors.push(`deliverables[${i}].delivered is required (boolean)`);
        if (!d.description) errors.push(`deliverables[${i}].description is required`);
      }
    }

    if (input.finalStatus === 'INCOMPLETE') {
      if (!Array.isArray(input.missingItems) || input.missingItems.length === 0) {
        errors.push('missingItems must be a non-empty array when finalStatus is INCOMPLETE');
      } else {
        for (let i = 0; i < input.missingItems.length; i++) {
          if (typeof input.missingItems[i] !== 'string') {
            errors.push(`missingItems[${i}] must be a string`);
          }
        }
      }
    }

    const basename = require('path').basename(input.reportPath || '');
    if (basename !== 'completion.check.md') {
      errors.push(`reportPath basename must be "completion.check.md" (got "${basename}")`);
    }

    return errors;
  },

  formatReport(input) {
    const lines = [];
    const timestamp = new Date().toISOString();

    lines.push(`**Changes Hash:** ${input.changesHash}`);
    lines.push(`Status: ${input.finalStatus}`);
    lines.push('');
    lines.push('# Requirements Verification');
    lines.push('');
    lines.push(`- **Date:** ${timestamp}`);
    lines.push('');

    // Original Request
    lines.push('## Original Request');
    lines.push('');
    lines.push(input.originalRequest);
    lines.push('');

    // Deliverables Checklist
    lines.push('## Deliverables Checklist');
    lines.push('');
    for (const d of input.deliverables) {
      const checkbox = d.delivered ? '[x]' : '[ ]';
      const status = d.delivered ? 'DELIVERED' : 'PENDING';
      lines.push(`- ${checkbox} ${d.requirement} - ${status}: ${d.description}`);
    }
    lines.push('');

    // Planning Gaps
    if (input.planningGaps && input.planningGaps.length > 0) {
      lines.push('## Planning vs Delivery Gaps');
      lines.push('');
      for (const gap of input.planningGaps) {
        lines.push(`- ${gap}`);
      }
      lines.push('');
    }

    // Final Status
    lines.push('## Final Status');
    lines.push('');
    if (input.finalStatus === 'COMPLETE') {
      lines.push('**[COMPLETE]** - All requirements have been delivered.');
    } else {
      const missing = input.missingItems || [];
      lines.push(`**[INCOMPLETE]** - Missing: ${missing.join(', ')}`);
    }
    lines.push('');

    return lines.join('\n');
  },
});

writer.run().catch((err) => {
  process.stderr.write(`[Completion Report Writer] Unexpected error: ${err.message}\n`);
  process.exit(1);
});
