# createTransitionStep

Factory for /work steps with one or two cases — "always RUN one command"
or "DEFER on a single precondition, else RUN". Use for `commit`, `ready`,
`cleanup`, `complete`-style steps.

## Decision matrix

| # | Condition | Action |
|---|---|---|
| 1 | `precondition(s, ctx) === false` (when provided) | DEFER with `skipReason` |
| 2 | otherwise | RUN `command` with `agentType` + `agentPrompt` |

## Usage

```js
module.exports = createTransitionStep({
  id: STEPS.commit,
  command: '/commit-writer',
  precondition: (s) => Boolean(s?.hasUncommittedChanges),
  skipReason: 'Nothing to commit',
  runReason: ({ s }) => `Commit ${s.changedFiles?.length || 0} file(s)`,
  retryTo: null,
});
```
