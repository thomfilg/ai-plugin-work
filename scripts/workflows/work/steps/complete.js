/**
 * Step: complete
 * Finalizes the workflow: marks state complete, releases session guard,
 * and archives enforcement artifacts.
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function completeStep(add, s, ctx) {
  const { STEPS, safeName, safeBase, tasksDir, sessionGuardPath, workStatePath } = ctx;

  add(STEPS.complete, 'RUN', 'Task(Bash)', 'Finish', {
    agentType: 'Bash',
    agentPrompt: [
      `Run these commands in sequence:`,
      `1. node "${workStatePath}" complete ${safeName}`,
      `2. node "${sessionGuardPath}" finish ${safeBase}`,
      `3. Archive enforcement artifacts: move *.check.md, .work-actions.json, tdd-phase.json, .step-evidence.json from ${tasksDir} to ${tasksDir}/archive/`,
      ``,
      `Step 1 marks the workflow as complete (exits 0 on success, exits 1 on failure — do NOT ignore failures).`,
      `Step 2 is an atomic teardown: reveals the session passphrase (unlocking the Stop hook) and removes the session file. Exits 0 when no session exists (guard disabled or already cleaned up). Exits 1 only if called without a ticket ID (programming error).`,
      `Step 3 archives workflow artifacts so they are preserved but do not interfere with future runs.`,
    ].join('\n'),
  });
};
