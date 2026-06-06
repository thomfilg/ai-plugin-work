# maestroPhaseValidator

CI-grade completeness check for the tuple
`{ BASE, PHASES, detectors, stepIds? }` that `plugins/maestro/scripts/lib/maestro-conduct/phase-registry.js`
and `plugins/maestro/scripts/maestro-conduct.js` produce.

Analogous to `factories/registryValidator` but maestro-flavoured. The
problem it solves: a typo in
`PHASES['implement'].detectors = [..., 'commiStall']` (missing `t`)
silently never fires that detector. Maestro doesn't crash — it just runs
without the detector. This validator catches the typo at test time.

## What it catches

| Rule | Failure |
|---|---|
| R1 | `BASE.detectors` references a name not in `detectors` |
| R2 | `PHASES[*].detectors` references a name not in `detectors` |
| R3 | A single `detectors[]` list contains a duplicate name |
| R4 | (when `stepIds` is provided) `PHASES` key isn't a known /work step id |
| R5 | `detectors[key].name !== key`, or no `detect()` function |
| W1 | (warning) detector is registered but no phase or BASE references it |

## Usage in tests

```js
const { validatePhaseRegistry } = require('factories/maestroPhaseValidator');
const phaseReg = require('plugins/maestro/scripts/lib/maestro-conduct/phase-registry');
const { DETECTORS } = require('plugins/maestro/scripts/maestro-conduct');
const { STEPS } = require('plugins/work/scripts/workflows/work/step-registry');

const result = validatePhaseRegistry({
  BASE: { detectors: phaseReg.phaseFor('__never_a_phase__').detectors },
  PHASES: phaseReg.PHASES,
  detectors: DETECTORS,
  stepIds: Object.values(STEPS),
});
assert.equal(result.valid, true, result.errors.join('\n'));
```

The validator's own test suite already runs this self-test against the
real maestro + /work registries, so the factories' `node --test` run is
sufficient — no additional wiring required in the maestro plugin's test
suite.

## Why this factory is stand-alone (in `factories/`, not in maestro)

Same reason as `registryValidator`: it's a structural check on registry
shape, independent of maestro's runtime. Lives alongside the other
validators so all "registry completeness" tests land in one place. It
imports the maestro tree only inside the self-test, so the factory itself
keeps the zero-coupling-to-plugin-code property the rest of `factories/`
maintains.

## What this validator does NOT do

- Doesn't enforce `budgetMin` upper/lower bounds — those are policy, not
  structure. Add a separate test if you want one.
- Doesn't check `escalationFor()` semantics (soft → interrupt → alert).
- Doesn't replace detector-level unit tests. It only validates the
  wiring.
