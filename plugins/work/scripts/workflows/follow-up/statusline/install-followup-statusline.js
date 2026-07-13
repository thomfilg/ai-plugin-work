#!/usr/bin/env node
'use strict';
/**
 * install-followup-statusline.js — register/remove the /follow-up status bar.
 *
 *   (no args)   register the follow-up bar as a fragment under the shared host
 *   --print     show resolved renderer path + current/host config
 *   --remove    remove only the follow-up fragment (other bars untouched)
 *
 * All host + settings.json plumbing (and the codex guard) lives in the shared
 * lib/statusline/install-statusline.js. Renderer path resolves from __dirname
 * (never process.env.CLAUDE_PLUGIN_ROOT).
 */
const path = require('path');

const { runStatuslineInstaller } = require('../../lib/statusline/install-statusline');

runStatuslineInstaller({
  mode: process.argv[2],
  label: 'follow-up',
  renderer: path.join(__dirname, 'followup-statusline.sh'),
  fragment: '30-followup.cmd',
  codexNote:
    'Watch follow-up progress from the CLI instead:\n' +
    "  watch -n 3 'cat <TASKS_BASE>/<ticket>/.follow-up-state.json'\n" +
    '(the /follow-up monitor step keeps writing that state file on codex too)\n',
});
