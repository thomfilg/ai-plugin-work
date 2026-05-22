/**
 * Step: 4_run_tests — Run automated tests inline (deterministic).
 * If tests fail, returns blocked so work-next.js can transition back to implement.
 *
 * Test runner priority:
 *   0. SCRIPT_RUN_AFFECTED_UNIT/INTEGRATION/E2E env vars (affected-only, fastest)
 *   1. $LINT_COMMAND / $TYPECHECK_COMMAND / $TEST_COMMAND env vars via dev-check.sh
 *   2. pnpm dev:check (project-defined)
 *   3. Bundled dev-check.sh
 *   4. pnpm test / node --test (fallback)
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
 *
 * Tier 0 (preferred): per-suite SCRIPT_RUN_AFFECTED_* env vars. Each set
 *   suite is run in sequence; the first non-zero exit short-circuits.
 *   This lets repos plug in their own affected-detection (nx, turbo, custom).
 * Tier 1: $LINT_COMMAND / $TYPECHECK_COMMAND / $TEST_COMMAND env vars routed
 *   through the bundled dev-check.sh which evaluates them with $CHANGED_FILES.
 * Tier 2: pnpm dev:check
 * Tier 3: bundled dev-check.sh
 * Tier 4: pnpm test fallback
 */
function runQualityGate(checkHooksDir) {
  // Tier 0: per-suite SCRIPT_RUN_AFFECTED_* — run each defined suite, stop on first failure
  const suites = [
    { name: 'unit', cmd: process.env.SCRIPT_RUN_AFFECTED_UNIT },
    { name: 'integration', cmd: process.env.SCRIPT_RUN_AFFECTED_INTEGRATION },
    { name: 'e2e', cmd: process.env.SCRIPT_RUN_AFFECTED_E2E },
  ].filter((s) => s.cmd);

  if (suites.length > 0) {
    const outputs = [];
    for (const { name, cmd } of suites) {
      outputs.push(`### ${name} (${cmd})`);
      const result = runCommand(cmd, 600000);
      outputs.push(result.output);
      if (result.exitCode !== 0) {
        return {
          output: outputs.join('\n'),
          exitCode: result.exitCode,
          tier: `affected-${name} (failed)`,
        };
      }
    }
    return {
      output: outputs.join('\n'),
      exitCode: 0,
      tier: `affected (${suites.map((s) => s.name).join('+')})`,
    };
  }

  const devCheckScript = path.join(
    checkHooksDir,
    '..',
    '..',
    'scripts',
    'dev-check',
    'dev-check.sh'
  );

  // Tier 1: env-var overrides — dev-check.sh already honors LINT_COMMAND /
  // TYPECHECK_COMMAND / TEST_COMMAND, so routing through it lets repos override
  // every step via .envrc without touching package.json.
  const envOverridesPresent =
    process.env.LINT_COMMAND || process.env.TYPECHECK_COMMAND || process.env.TEST_COMMAND;
  if (envOverridesPresent && fs.existsSync(devCheckScript)) {
    const result = runCommand(`bash "${devCheckScript}"`, 120000);
    return { ...result, tier: 'dev-check.sh ($LINT/$TYPECHECK/$TEST_COMMAND)' };
  }

  // Tier 2: pnpm dev:check
  try {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    if (pkg.scripts && pkg.scripts['dev:check']) {
      const result = runCommand('pnpm dev:check', 120000);
      return { ...result, tier: 'pnpm dev:check' };
    }
  } catch {
    /* no package.json */
  }

  // Tier 3: bundled dev-check script
  if (fs.existsSync(devCheckScript)) {
    const result = runCommand(`bash "${devCheckScript}"`, 120000);
    return { ...result, tier: 'dev-check.sh' };
  }

  // Tier 4: pnpm test or node --test
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
