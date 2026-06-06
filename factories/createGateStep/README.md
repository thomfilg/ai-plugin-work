# createGateStep

Declarative factory for gate steps in a linear step machine with retry
edges. A gate step is one that reads an artifact, validates it, and
either DEFERs (artifact is ready) or RUNs a skill to fix or regenerate
it.

## Decision matrix (fixed, no other branches possible)

| # | Condition | Action |
|---|---|---|
| 1 | `precondition(s, ctx) === false` | DEFER with `noArtifactReason` |
| 2 | artifact unreadable | RUN `failClosedCommand` (fail-closed) |
| 3 | `parse(text)` throws | RUN `runCommand` with "parser threw" reason |
| 4 | `validate(parsed)` throws | RUN `runCommand` with "validator threw" reason |
| 5 | `validate(parsed).valid === true` | DEFER with `validate.deferReason(parsed)` |
| 6 | `validate(parsed).valid === false` | RUN `runCommand` with `validate.runReason(parsed)` and `validate.runExtra(parsed, validation, ctx)` |

## Usage

```js
const { createGateStep } = require('factories/createGateStep');
const openQuestions = require('../lib/open-questions');

module.exports = createGateStep({
  id: STEPS.brief_gate,
  artifact: 'brief.md',
  precondition: (s) => Boolean(s && s.hasBrief),
  parse: (text) => openQuestions.parse(text),
  validate: (parsed) => {
    const blocking = openQuestions.findBlocking(parsed);
    if (blocking.length === 0) {
      return { valid: true, deferReason: 'All blocking questions resolved' };
    }
    return {
      valid: false,
      runReason: () => `Resolve ${blocking.length} blocking question(s)`,
    };
  },
  runCommand: '/brief',
  retryTo: 'brief',
});
```

## Why this shape

The hand-written gates (`brief-gate.js`, `spec-gate.js`, `tasks-gate.js`)
all replicate the same 5-branch table in different prose. Each one re-checks
artifact existence, re-handles the read error, re-handles the parser throw,
and re-decides defer-vs-run. Drift between the JSDoc decision matrix and
the actual control flow is silent.

This factory makes the matrix the **only** place behavior is described. The
LLM picks the values; it cannot inject a 6th branch.

## Exporting auxiliary handlers

Gates often pair the step function with a post-resolve handler (e.g.
`brief-gate.js` exports `applyBriefResolutions` for the orchestrator to
call after AskUserQuestion returns). The factory returns only the step
function, so attach helpers as side-exports:

```js
const briefGateStep = createGateStep({ /* … */ });

function applyBriefResolutions(briefPath, resolutions) { /* … */ }

module.exports = briefGateStep;
module.exports.briefGateStep = briefGateStep;
module.exports.applyBriefResolutions = applyBriefResolutions;
```

The orchestrator can then `require('./brief-gate').applyBriefResolutions`
without the factory needing to know about handler-exports.

## Not covered by this factory

- Steps that need to mutate sibling plan entries (use `createTransitionStep`
  or write by hand)
- Steps with more than one artifact (write by hand — see `tasks-gate.js`
  Gate C+D composition)
- Steps that conditionally invoke `AskUserQuestion` with a runtime-built
  payload — pass that builder via `validate.runExtra(parsed, validation)`
