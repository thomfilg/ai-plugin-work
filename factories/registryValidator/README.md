# registryValidator

CI-grade completeness check for the `{ STEPS, STEP_ORDER, STEP_TRANSITIONS,
STEP_PIPELINE }` tuple in `plugins/work/scripts/workflows/work/step-registry.js`.

`STEP_TRANSITIONS` is the merged forward+retry graph the registry actually
exports (`RETRY_EDGES` is internal and not part of the module's public
surface). The validator derives backward/forward edge classification from
the `STEP_ORDER` indices.

## What it catches

| Rule | Failure |
|---|---|
| R1 | `STEPS.x` not in `STEP_ORDER` (or vice versa) |
| R2 | `STEP_TRANSITIONS` key not in `STEPS` |
| R3 | Transition target is neither linear-forward, backward, nor the terminal self-loop |
| R4 | `STEP_PIPELINE[i]` is not a function |
| R5 | Factory-built step's `__factoryMeta.retryTo` not reflected as a backward edge in `STEP_TRANSITIONS` |
| R6 | Duplicate id in `STEP_ORDER` |

## Usage in CI

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateRegistry } = require('../../../../../factories/registryValidator');
const registry = require('../step-registry');
const { STEP_PIPELINE } = require('../steps');

test('step registry is complete', () => {
  const r = validateRegistry({
    STEPS: registry.STEPS,
    STEP_ORDER: registry.STEP_ORDER,
    STEP_TRANSITIONS: registry.STEP_TRANSITIONS,
    STEP_PIPELINE,
  });
  assert.equal(r.valid, true, r.errors.join('\n'));
});
```

The validator's own test file already imports the real registry and
asserts validity, so the factories' `node --test` run is sufficient on its
own — no additional wiring required in the plugin's test suite.

A new step that adds `STEPS.foo` but forgets to add it to `STEP_ORDER`, or
adds a transition that skips a linear step, fails the check.
