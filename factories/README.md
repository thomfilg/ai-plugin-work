# factories

Plugin-agnostic, reusable building blocks that turn hand-written boilerplate
into declarative data. Every module here forces plugins toward predictable,
debuggable behaviors — the point is to make the LLM fill in a *table*, not a
free-form function body that drifts from its JSDoc.

## The three-rule standard

A module belongs in `factories/` if and only if **all three** hold:

1. **No plugin imports.** The factory module's `require()` graph does not
   reach into `plugins/**`. (Self-tests may import the real plugin tree as
   fixtures — that's how the self-test proves the factory matches reality.
   The factory module itself must not.)
2. **No plugin-branded names or hardcoded paths.** Directory names, function
   names, error messages, README framing, and CLI output may not name a
   specific plugin. Schemas must accept shapes any plugin could produce.
3. **The factory enforces a predictable/debuggable behavior.** Either:
   (a) replaces hand-written boilerplate with a declarative call (decision
   matrix becomes data), (b) validates that registries / dispatch tables
   are consistent, or (c) centralizes a cross-cutting concern (safe IO,
   atomic writes, hook entrypoint protocol).

A module failing any rule gets reworked, relocated, or dropped.

## Taxonomy

### Step builders

Declarative builders that compile to the `(add, s, ctx) => void` step contract
of a linear step machine with retry edges and a handler pipeline. Decision
matrix lives in the call options; the factory emits the handler.

| Shape | Builder | Real-world example |
|---|---|---|
| "Check artifact → parse → validate → DEFER or RUN /skill" | `createGateStep` | `brief-gate.js`, `spec-gate.js`, `tasks-gate.js` |
| "If file missing → RUN /skill to produce it; else DEFER" | `createArtifactStep` | `brief.js`, `spec.js`, `tasks.js` |
| "Always RUN one command; or DEFER on a single precondition" | `createTransitionStep` | `commit.js`, `ready.js`, `cleanup.js` |
| "One RUN whose agentPrompt is assembled from N optional sections" | `createAgentInvocationStep` | `implement.js` |
| "Pseudo-step: mutate sibling plan entries instead of emitting one" | `createPlanMutatorStep` | `task-advance.js` |

### Event-handler builders

Declarative builders for `{ detect(ctx) → hit }` modules dispatched by an
event loop. Currently: `createDetectorRunner` (wraps a detector module with
the guard / dispatch / short-circuit envelope an event runner needs).

### Registry validators

Structural completeness checks over a plugin's registry shape. Each ships a
self-test that asserts validity against a real fixture so structural drift
fails CI.

| Validator | What it validates |
|---|---|
| `registryValidator` | A linear step machine with retry edges and a handler pipeline — every step id is in the step order, every transition target is a forward / backward / terminal-self edge, every pipeline handler with `__factoryMeta` has a registry entry. |
| `dispatchRegistryValidator` | An event-driven dispatch registry: `{ handlers, dispatch, baseDispatch?, handlerShape?, tagSet?, allowOrphans? }`. Every name in `dispatch[*]` resolves to a registered handler; no duplicates; (optionally) every dispatch key is in `tagSet`; every handler conforms to `handlerShape`. |

## Enforcement stack

1. **Factories** make the matrix declarative — the LLM fills in a table, the
   factory emits the handler.
2. **`registryValidator`** runs in CI to assert step-machine completeness on
   any registry that opts in.
3. **`dispatchRegistryValidator`** runs the analogous check over an
   event-driven dispatch table: every handler name referenced by
   `baseDispatch` or any `dispatch[*]` list resolves to a registered
   handler, no duplicates, and (when given a `tagSet`) every dispatch key
   is a known tag.
4. **Line-count cap (aspirational).** Many step / gate files shrink
   dramatically once migrated to the builders above — e.g. a 161-LOC
   gate becomes ~25 LOC of `createGateStep({…})`. A `max-lines: 120`
   override on `steps/*` and `gates/*` is the goal once migration is
   complete.

## Wiring

Factories are **stand-alone** — they don't import from `plugins/**`, so they
can be code-reviewed and tested in isolation. To adopt one, replace a
hand-written step body with the corresponding `createXStep({...})` call and
re-export the result. The downstream pipeline consumes the returned function
exactly as it did the hand-written one.

## Tests

Each factory ships a Node native test file:

```bash
node --test factories/**/__tests__/*.test.js
```
