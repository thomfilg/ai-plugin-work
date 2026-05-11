/**
 * Step: 4_run_tests — Run automated tests inline (deterministic).
 * If tests fail, returns blocked so work-next.js can transition back to implement.
 *
 * Test runner priority:
 *   0. SCRIPT_RUN_AFFECTED_UNIT env var (affected-only tests, fastest)
 *   1. pnpm dev:check (project-defined)
 *   2. Bundled dev-check.sh
 *   3. pnpm test / node --test (fallback)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function runCommand(cmd, timeout) {
  try {
    const output = execSync(`${cmd} 2>&1`, { encoding: 'utf8', timeout });
    return { output, exitCode: 0 };
  } catch (err) {
    return {
      output: (err.stdout || '') + (err.stderr || ''),
      exitCode: err.status || 1,
    };
  }
}

/**
 * Run quality gate and return { output, exitCode, tier }.
 */
function runQualityGate(checkHooksDir) {
  // Tier 0: SCRIPT_RUN_AFFECTED_UNIT — affected-only tests (fastest, set via .envrc)
  const affectedUnit = process.env.SCRIPT_RUN_AFFECTED_UNIT;
  if (affectedUnit) {
    const result = runCommand(affectedUnit, 300000);
    return { ...result, tier: 'affected-unit' };
  }

  // Tier 1: pnpm dev:check
  try {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    if (pkg.scripts && pkg.scripts['dev:check']) {
      const result = runCommand('pnpm dev:check', 120000);
      return { ...result, tier: 'pnpm dev:check' };
    }
  } catch {
    /* no package.json */
  }

  // Tier 2: bundled dev-check script
  const devCheckScript = path.join(
    checkHooksDir,
    '..',
    '..',
    'scripts',
    'dev-check',
    'dev-check.sh'
  );
  if (fs.existsSync(devCheckScript)) {
    const result = runCommand(`bash "${devCheckScript}"`, 120000);
    return { ...result, tier: 'dev-check.sh' };
  }

  // Tier 3: pnpm test or node --test
  const result = runCommand('pnpm test || node --test', 120000);
  return { ...result, tier: 'pnpm test' };
}

function registerRunTests(register) {
  register('4_run_tests', (state, ctx) => {
    const reportFolder = state.setupResult?.reportFolder || ctx.tasksDir;
    const changesHash = state.changesHash || 'unknown';
    const reportPath = path.join(reportFolder, 'tests.check.md');

    const result = runQualityGate(ctx.checkHooksDir);

    // Parse counts
    const passMatch = result.output.match(/pass\s+(\d+)/i);
    const failMatch = result.output.match(/fail\s+(\d+)/i);
    const passCount = passMatch ? passMatch[1] : '?';
    const failCount = failMatch ? failMatch[1] : '?';
    const status = result.exitCode === 0 ? 'APPROVED' : 'NEEDS_WORK';

    // Write report
    const report = [
      `**Changes Hash:** ${changesHash}`,
      '',
      `Status: ${status}`,
      '',
      '# Test Results Report',
      '',
      `**Runner:** ${result.tier}`,
      `**Exit code:** ${result.exitCode}`,
      `**Pass:** ${passCount} | **Fail:** ${failCount}`,
      '',
      '## Output',
      '```',
      result.output.substring(0, 5000),
      '```',
      '',
      '## Verdict',
      `**${status}**${result.exitCode === 0 ? ' - All tests pass' : ` - ${failCount} test(s) failing`}`,
    ].join('\n');

    fs.writeFileSync(reportPath, report);

    if (result.exitCode !== 0) {
      state.testsFailed = true;
      return {
        type: 'check_instruction',
        action: 'failed',
        state: { ticket: state.ticketId, currentStep: '4_run_tests', progress: '4/9' },
        reason: `Tests failed (${failCount} failing). Needs fix in implement step.`,
        report: reportPath,
      };
    }

    return null; // auto-advance
  });
}

module.exports = registerRunTests;
module.exports.runQualityGate = runQualityGate;
