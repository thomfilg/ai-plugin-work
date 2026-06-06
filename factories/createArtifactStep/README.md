# createArtifactStep

Declarative factory for /work steps that produce an artifact file via a skill
or agent (`brief.js`, `spec.js`, `tasks.js`).

## Decision matrix

| # | Condition | Action |
|---|---|---|
| 1 | `precondition(s, ctx) === false` | DEFER with `skipReason` |
| 2 | `artifactExists(s, ctx) === true` | DEFER with `existsReason` |
| 3 | otherwise | RUN `command` with `agentType` + `agentPrompt` (+ planning context if opted-in) |

## Usage

```js
const { createArtifactStep } = require('factories/createArtifactStep');

module.exports = createArtifactStep({
  id: STEPS.spec,
  artifact: 'spec.md',
  precondition: (s) => Boolean(s?.hasBrief),
  artifactExists: (s) => Boolean(s?.hasSpec),
  command: '/spec',
  agentType: 'skill',
  agentPrompt: '/spec',
  injectPlanningContext: true,
  skipReason: 'No brief — run /brief first',
  existsReason: 'spec.md already present',
  runReason: ({ ctx }) => `Produce spec.md in ${ctx.tasksDir}`,
});
```
