# stepScaffold

CLI that writes a new `steps/<id>.js` file from a factory template and
**prints** the registry edits the human still needs to make. It does NOT
patch `step-registry.js` or `steps/index.js` — that's the forcing
function so `registryValidator` catches anything you forget.

## Usage

```bash
node factories/stepScaffold/cli.js \
  --id=foo_gate \
  --kind=gate \
  --artifact=foo.md \
  --command=/foo-skill \
  --retry-to=foo \
  --out=plugins/work/scripts/workflows/work/steps/foo-gate.js
```

Output:

```
✓ wrote plugins/work/scripts/workflows/work/steps/foo-gate.js

── Registry edits (apply these by hand) ──
  1. plugins/work/scripts/workflows/work/step-registry.js
       STEPS.foo_gate = 'foo_gate'
       STEP_ORDER: insert 'foo_gate' in canonical order
       RETRY_EDGES['foo_gate'] = ['foo']
  2. plugins/work/scripts/workflows/work/steps/index.js
       const fooGate = require('./foo-gate');
       STEP_PIPELINE: insert at the matching position
```

## Kinds

- `gate` → `createGateStep` template (artifact + precondition + parse + validate)
- `artifact` → `createArtifactStep` template
- `transition` → `createTransitionStep` template
- `agent-invocation` → `createAgentInvocationStep` template
- `plan-mutator` → `createPlanMutatorStep` template

## Why no auto-patch?

Editing `step-registry.js` and `steps/index.js` requires AST-level surgery
to insert at the right ordered position without clobbering surrounding
comments — high risk for a code-generation step. Printing the edits keeps
the human in the loop. `registryValidator` then enforces that the edits
were actually applied, so a missed insertion fails CI.
