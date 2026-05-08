/**
 * Step: 8_output — Read README.md and return display instruction.
 */

'use strict';

const fs = require('fs');
const path = require('path');

module.exports = function registerOutput(register) {
  register('8_output', (state, ctx) => {
    const readmePath = path.join(ctx.tasksDir, 'README.md');
    let readme = 'No summary generated.';
    try {
      readme = fs.readFileSync(readmePath, 'utf8');
    } catch {
      /* no README */
    }

    return {
      type: 'check_instruction',
      action: 'display',
      state: { ticket: state.ticketId, currentStep: '8_output', progress: '8/9' },
      content: readme,
      continue: true,
    };
  });
};
