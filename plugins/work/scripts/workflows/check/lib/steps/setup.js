/**
 * Step: 1_setup — Run check-setup.js inline (deterministic).
 * Populates state.setupResult with report folder, changes hash, impacted apps.
 * If cache hit → jumps to 8_output.
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

module.exports = function registerSetup(register) {
  register('1_setup', (state, ctx) => {
    try {
      const result = execFileSync(
        process.execPath,
        [path.join(ctx.checkHooksDir, 'check-setup.js'), state.ticketId],
        { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      state.setupResult = JSON.parse(result);
      state.changesHash = state.setupResult.changesHash;

      // Cache hit → skip to output
      if (state.setupResult.cache && state.setupResult.cache.cached) {
        state.currentStep = '11_output';
        return {
          type: 'check_instruction',
          action: 'cached',
          state: { ticket: state.ticketId, currentStep: '11_output' },
          summary: `Reports up-to-date (hash: ${state.changesHash}). No re-check needed.`,
          readme: state.setupResult.cache.readme,
        };
      }
    } catch {
      // Defaults so later steps (start-env, phase1, validate) have the fields they read
      state.setupResult = {
        reportFolder: ctx.tasksDir,
        changesHash: 'unknown',
        impactedApps: [],
        affectedFiles: {},
      };
      state.changesHash = 'unknown';
    }
    return null; // auto-advance — later steps read state.setupResult
  });
};
