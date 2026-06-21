/**
 * instruction-guards.js — shared process-level crash guards for orchestrators.
 *
 * Installs `uncaughtException` / `unhandledRejection` handlers that print a
 * single JSON workflow instruction (`{ type, action: 'blocked', reason }`) to
 * stderr and exit 1, so a crashing orchestrator still emits a parseable
 * blocked-instruction rather than a raw stack trace. Shared by the /follow-up
 * and /check2 orchestrators (previously a cross-file duplicate-block).
 */

'use strict';

/**
 * @param {string} instructionType - the `type` field on the emitted instruction
 *   (e.g. `'follow_up_instruction'`, `'check_instruction'`).
 */
function installInstructionGuards(instructionType) {
  process.on('uncaughtException', (err) => {
    console.error(
      JSON.stringify({
        type: instructionType,
        action: 'blocked',
        reason: `Uncaught exception: ${err.message}`,
        stack: err.stack,
      })
    );
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        type: instructionType,
        action: 'blocked',
        reason: `Unhandled rejection: ${msg}`,
      })
    );
    process.exit(1);
  });
}

module.exports = { installInstructionGuards };
