/**
 * Step: 7_quality_recheck — Re-run quality checks if code was modified during consensus.
 * Deterministic — runs inline via runQualityGate (same as 4_run_tests).
 * Skips if no files were modified.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

module.exports = function registerQualityRecheck(register) {
  register('7_quality_recheck', (state, ctx) => {
    // Check if code was modified during consensus
    let hasModifiedFiles = false;
    try {
      const status = execSync('git status --porcelain', { encoding: 'utf8', timeout: 5000 }).trim();
      hasModifiedFiles = status !== '';
    } catch {
      /* fail-open */
    }

    if (!hasModifiedFiles) return null; // no changes → skip

    // Run quality gate inline (deterministic — no agent needed)
    const { runQualityGate } = require('./run-tests');
    const reportFolder = state.setupResult?.reportFolder || ctx.tasksDir;
    const changesHash = state.changesHash || 'unknown';

    const result = runQualityGate(ctx.checkHooksDir);

    // Write recheck report
    const passMatch = result.output.match(/pass\s+(\d+)/i);
    const failMatch = result.output.match(/fail\s+(\d+)/i);
    const passCount = passMatch ? passMatch[1] : '?';
    const failCount = failMatch ? failMatch[1] : '?';
    const status2 = result.exitCode === 0 ? 'APPROVED' : 'NEEDS_WORK';

    const report = [
      `**Changes Hash:** ${changesHash}`,
      '',
      `Status: ${status2}`,
      '',
      '# Quality Re-check Report (post-consensus)',
      '',
      `**Runner:** ${result.tier}`,
      `**Exit code:** ${result.exitCode}`,
      `**Pass:** ${passCount} | **Fail:** ${failCount}`,
      '',
      '## Output',
      '```',
      result.output.substring(0, 5000),
      '```',
    ].join('\n');

    const reportPath = path.join(reportFolder, 'recheck.check.md');
    fs.writeFileSync(reportPath, report);

    if (result.exitCode !== 0) {
      return {
        type: 'check_instruction',
        action: 'failed',
        state: { ticket: state.ticketId, currentStep: '7_quality_recheck', progress: '7/9' },
        reason: `Quality re-check failed (${failCount} failing). Code review fixes broke tests.`,
        report: reportPath,
      };
    }

    return null; // auto-advance
  });
};
