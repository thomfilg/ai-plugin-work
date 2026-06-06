# Plugin factories & registry validators

Three kinds of modules live here:

- **Step factories** (`/work` step machine) — declarative builders that
  compile to the `(add, s, ctx) => void` step contract used by
  `plugins/work/scripts/workflows/work/steps/*.js`. The point is to make
  the decision matrix a piece of *data* the LLM has to fill in, not a
  free-form function body that drifts from its JSDoc.
- **Event-loop factories** (`maestro` event machine) — declarative
  builders for the `(ctx, isEligible) => boolean` detector-runner
  contract used in `plugins/maestro/scripts/maestro-conduct.js`.
  Currently: `createDetectorRunner` (wraps a `{detect(ctx) → hit}`
  module with the guard/dispatch/short-circuit envelope).
- **Registry validators** — completeness checks over a plugin's registry
  shape. `registryValidator` covers `/work`'s step graph;
  `maestroPhaseValidator` covers `maestro`'s phase/detector graph. Both
  ship a self-test that imports the real registry and asserts validity,
  so any structural drift fails CI.

## When to use which factory

| Shape | Factory | Real-world example |
|---|---|---|
| "Check artifact → parse → validate → DEFER or RUN /skill" | `createGateStep` | `brief-gate.js`, `spec-gate.js`, `tasks-gate.js` |
| "If file missing → RUN /skill to produce it; else DEFER" | `createArtifactStep` | `brief.js`, `spec.js`, `tasks.js` |
| "Always RUN one command; or DEFER on a single precondition" | `createTransitionStep` | `commit.js`, `ready.js`, `cleanup.js` |
| "One RUN whose agentPrompt is assembled from N optional sections" | `createAgentInvocationStep` | `implement.js` |
| "Pseudo-step: mutate sibling plan entries instead of emitting one" | `createPlanMutatorStep` | `task-advance.js` |
| "Wrap a `{detect}` module with guard / dispatch / short-circuit" | `createDetectorRunner` | `runSpinnerDetector`, `runSilenceDetector`, `runPhaseStallDetector`, `runCommitStallDetector`, `runPrCommentsDetector`, `runPrStatusDetector` (all in `maestro-conduct.js`) |

The following stay hand-written by design — they don't fit any factory:

| File | Why it's hand-written |
|---|---|
| `engine/unstick-complete.js` | Recovery orchestrator with its own CLI surface, not a plan-generation step |
| `steps/commit.js` | Four branches + emits the third action type `PENDING` (not RUN/DEFER); no factory models this |
| `steps/implement.js` | Has side effects (`execFileSync` task-init, audit `appendAction`), exports `ctx._taskData` / `_allTasksDone` / `_currentTaskIdx` for `task-advance`, and has three distinct DEFER variants — beyond what `createAgentInvocationStep`'s "sections joined by `\n\n`" model covers |

## Enforcement stack

1. **Factories** make the matrix declarative — the LLM fills in a table, the
   factory emits the handler.
2. **`registryValidator`** (`/work`) runs in CI to assert that every
   `STEPS.x` is in `STEP_ORDER`, every `STEP_TRANSITIONS` target is a
   linear-forward, backward, or terminal-self edge, and every
   `STEP_PIPELINE` handler with `__factoryMeta` has a registry entry.
3. **`maestroPhaseValidator`** (`maestro`) runs the analogous check over
   `phase-registry.PHASES`: every detector name referenced by `BASE` or
   any `PHASES[*].detectors` must resolve to a real detector module
   exported from `maestro-conduct.js`, no duplicates, and (when given the
   /work step-id set) every phase key must be a known step.
4. **Line-count cap.** Aspirational target: 120 LOC per file under
   `plugins/work/scripts/workflows/work/steps/*` and `.../gates/*`. NOT
   yet enforced by `pnpm quality` — six existing step/gate files
   (`check-gate.js` 316, `implement.js` 311, `task-review-gate.js` 167,
   `brief-gate.js` 161, `tasks-gate.js` 151, `task-review.js` 122)
   exceed it. Most shrink dramatically once migrated to the factories
   above (brief-gate's 161 LOC → ~25 LOC of `createGateStep({…})`). Once
   migration is done, add a `files: [steps/*, gates/*]` override with
   `max-lines: 120` to `quality-lint-rules.js`.
5. **`stepScaffold`** is the CLI the LLM should reach for when adding a new
   step. `node factories/stepScaffold/cli.js --id=foo --kind=gate
   --retry-to=bar --out=…` writes the factory call to disk and PRINTS the
   registry edits the human needs to apply by hand (it does not patch
   `step-registry.js` or `steps/index.js` itself).

## Wiring

These factories are intentionally **stand-alone** today — they don't import
from `plugins/work/**`, so they can be code-reviewed and tested in isolation.
To adopt one, replace a hand-written step body with a `createGateStep({...})`
call and re-export the result. The downstream `STEP_PIPELINE` array consumes
the returned function exactly as it did the hand-written one.

## Tests

Each factory ships a Node native test file: `node --test factories/**/__tests__/*.test.js`
