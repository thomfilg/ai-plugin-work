# createPlanMutatorStep

For pseudo-steps that don't emit their own plan entry but instead **mutate
sibling entries**. Models `task-advance.js`, which patches the `check` and
`task_review` entries with `nextAction` / `taskInfo` / `finalTaskAction`
depending on task progress.

## Decision matrix

| # | Condition | Effect |
|---|---|---|
| 1 | `precondition === false` | no-op (no plan entry, no mutation) |
| 2 | otherwise | for each mutation whose `predicate(s, ctx)` returns true, apply `patch(entry, s, ctx)` to every `ctx.plan` entry whose `step` is in `targetStepIds` |

## Why a factory for `task-advance.js`?

Pseudo-steps are the most error-prone kind because they're silent — nothing
in the plan output points back at them. `task-advance.js` today hard-codes:

- which sibling steps it touches (`check`, `task_review`)
- which fields it sets (`nextAction`, `taskInfo`, `finalTaskAction`)
- two conditions (more tasks remain, last task)

If a future contributor adds a third condition or a new sibling to patch,
they have to re-read the whole 61-line file. With the factory, each
condition is one entry in `mutations: []` and the targets are explicit data.

## Usage (decomposing `task-advance.js`)

```js
module.exports = createPlanMutatorStep({
  id: STEPS.task_advance,
  mutations: [
    {
      id: 'more-tasks',
      targetStepIds: [STEPS.check, STEPS.task_review],
      predicate: (_s, c) => !c._allTasksDone && c._currentTaskIdx < c._taskData.length - 1,
      patch: (_entry, _s, c) => ({
        nextAction: 'advance_task',
        taskInfo: {
          current: c._currentTaskIdx + 1,
          total: c._taskData.length,
          nextTask: c._taskData[c._currentTaskIdx + 1]?.title,
        },
      }),
    },
    {
      id: 'last-task',
      targetStepIds: [STEPS.check],
      predicate: (_s, c) => !c._allTasksDone && c._currentTaskIdx === c._taskData.length - 1,
      patch: (_entry, _s, c) => ({
        finalTaskAction: 'complete_last_task',
        taskInfo: { current: c._currentTaskIdx + 1, total: c._taskData.length, isLast: true },
      }),
    },
  ],
});
```

## Caveat — registry handling

Plan mutators don't emit a `step` entry, so `registryValidator` R4 still
expects the handler to be a function (✓) but the step ID has no `RUN`/`DEFER`
appearance in the plan. The id should still be in `STEPS` and `STEP_ORDER`
for documentation purposes — `STEP_PIPELINE` iteration order is when the
mutation gets to run, so placement matters.
