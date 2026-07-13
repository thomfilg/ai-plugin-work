#!/usr/bin/env node

/**
 * ci-phase-state.js
 *
 * Writer for `tasks/<ticket>/ci-phase.json`. Unguarded — the ci step is
 * bookkeeping/polling and ci-next.js (the sole caller) is intentionally
 * NOT in agentGatedScripts (see workflow-definition.js).
 *
 * Factory contract (GH-478, Task 8):
 *   This file is a thin wrapper around the `createPhaseStateCli` factory
 *   at `plugins/work/scripts/workflows/lib/phase-state/create-phase-state-cli.js`.
 *   The factory itself always token-gates `init` / `record` / `transition`
 *   (verbatim port of the canonical `tasks-phase-state.js` shape).
 *
 *   To preserve the historical "unguarded" external CLI contract for ci
 *   without bloating the factory's surface, this wrapper self-mints a
 *   short-lived write-token for the `ci-runner` synthetic agent before
 *   delegating to the factory's `main(argv)`. External callers
 *   (orchestrator / main session) keep their token-free invocation;
 *   the gating round-trip is contained inside this wrapper. Public
 *   re-exports (`PHASES`, `ciCanTransition`, `ciNextPhases`) and the
 *   on-disk state-file format are preserved verbatim.
 *
 * Subcommands: `init`, `current`, `record`, `transition`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createPhaseStateCli } = require('../lib/phase-state/create-phase-state-cli');
const { tokenPath } = require('../lib/scripts/write-report');
const {
  CI_PHASE_ORDER,
  CI_INITIAL_PHASE,
  CI_TERMINAL_PHASE,
  ciNextPhases,
  ciCanTransition,
  isCiPhase,
} = require('./ci-phase-registry');

const SCRIPT_NAME = path.basename(__filename);
const SYNTHETIC_AGENT = 'ci-runner';
const GATED_SUBCOMMANDS = new Set(['init', 'record', 'transition']);

const cli = createPhaseStateCli({
  phaseRegistry: {
    PHASE_ORDER: CI_PHASE_ORDER,
    INITIAL_PHASE: CI_INITIAL_PHASE,
    TERMINAL_PHASE: CI_TERMINAL_PHASE,
    nextPhases: ciNextPhases,
    canTransition: ciCanTransition,
    isPhase: isCiPhase,
  },
  allowedAgents: [SYNTHETIC_AGENT],
  stateFileName: 'ci-phase.json',
  scriptFilename: __filename,
});

function mintSyntheticToken(ticketId) {
  if (!ticketId) return;
  try {
    const tp = tokenPath(SCRIPT_NAME, ticketId);
    fs.mkdirSync(path.dirname(tp), { recursive: true, mode: 0o700 });
    const payload = {
      agent: SYNTHETIC_AGENT,
      timestamp: Date.now(),
      tasksBase: null,
    };
    fs.writeFileSync(tp, JSON.stringify(payload), { mode: 0o600 });
  } catch {
    /* fail-open — the factory will surface a "missing token" error if mint failed */
  }
}

function maybeSelfMint(argv) {
  const args = argv.slice(2);
  const sub = args[0];
  const ticket = args[1];
  if (sub && GATED_SUBCOMMANDS.has(sub) && ticket) {
    mintSyntheticToken(ticket);
  }
}

if (require.main === module) {
  maybeSelfMint(process.argv);
  cli.main(process.argv);
}

module.exports = { PHASES: cli.PHASES, ciCanTransition, ciNextPhases };
