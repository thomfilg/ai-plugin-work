# createAgentInvocationStep

For steps that emit a single RUN entry whose `agentPrompt` is assembled
from several conditional context sections. This is the shape of
`implement.js`: one agent invocation, but the prompt has 6+ optional
pieces (task description, claim status, dep status, worker slot, planning
docs, TDD protocol).

## Decision matrix

| # | Condition | Action |
|---|---|---|
| 1 | `precondition(s, ctx) === false` | DEFER with `skipReason` |
| 2 | otherwise | RUN `command` with assembled `agentPrompt` + `extras` |

## Why a factory for `implement.js`?

Today, `implement.js` is 311 LOC. Most of it is helper functions
(`_readClaimOwner`, `_resolveWorkerSlot`, dependency builders) that
contribute one section to the prompt. The orchestrator picks which
helpers run and how their output is concatenated — ordering bugs are
silent, and adding a new section means editing the orchestrator.

With the factory, each section is a `{ id, build }` tuple. New sections
are appended as data, not woven into prose. The orchestrator file shrinks
to a config + a `sections/` directory of small build functions.

## Usage (decomposing `implement.js`)

```js
const { createAgentInvocationStep } = require('factories/createAgentInvocationStep');
const { buildTaskSection } = require('../lib/implement/section-task');
const { buildClaimSection } = require('../lib/implement/section-claim');
const { buildDepsSection } = require('../lib/implement/section-deps');
const { buildWorkerSection } = require('../lib/implement/section-worker');
const { buildPlanningSection } = require('../lib/implement/section-planning');

module.exports = createAgentInvocationStep({
  id: STEPS.implement,
  command: '/implement',
  agentType: 'general-purpose',
  precondition: (s) => Boolean(s?.hasTasks),
  sections: [
    { id: 'task',     build: buildTaskSection },
    { id: 'claim',    build: buildClaimSection },
    { id: 'deps',     build: buildDepsSection },
    { id: 'worker',   build: buildWorkerSection },
    { id: 'planning', build: buildPlanningSection },
  ],
  extras: (s, ctx) => ({
    taskInfo: ctx._taskData && {
      current: ctx._currentTaskIdx + 1,
      total: ctx._taskData.length,
    },
  }),
  retryTo: null,
});
```

Result: `implement.js` becomes ~25 LOC; each section is testable in
isolation; new contextual sections are one file, not a 311-LOC merge.

## Fail-open

If `section.build` throws, the section is silently omitted — the agent
still gets the other sections. This matches the existing implement.js
behavior of fail-open helpers.
