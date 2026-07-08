# dispatchRegistryValidator

CI-grade completeness check for an event-driven dispatch registry: the
tuple `{ handlers, dispatch, baseDispatch?, handlerShape?, tagSet?,
allowOrphans? }`.

The problem it solves: a typo like
`dispatch['implement'] = [..., 'commiStall']` (missing `t`) silently
never fires that handler. Nothing crashes — the handler just never runs.
This validator catches the typo at test time.

## Surface

```js
validateDispatchRegistry({
  handlers,       // { [name]: handlerModule } — the registry of handlers
  dispatch,       // { [tag]: string[] }      — tag → ordered handler-name list
  baseDispatch,   // optional string[] — default list applied when a tag override is absent
  handlerShape,   // { requiredFields: string[], optionalFields?: string[] }
                  //   default: { requiredFields: ['name', 'detect'] }
  tagSet,         // optional Set<string> — restrict dispatch keys to a known universe
  allowOrphans,   // bool (default true) — warn vs. error when a handler is never referenced
});
// → { valid, errors, warnings }
```

Both `dispatch[tag]` and `baseDispatch` accept either a flat `string[]`
of handler names or the legacy `{ detectors: string[] }` shape, so
existing maestro-style phase registries plug in without restructuring.

## SOLID enforcement

| Principle | How the validator enforces it |
|---|---|
| **L** (Liskov) | `handlerShape` checked against every handler — uniform interface or fail |
| **D** (Dep. Inversion) | Every name in `dispatch` resolves to a registered handler; no string typos slip through |
| **I** (Interface Seg.) | `requiredFields` is the minimum contract; handlers may expose more |
| **O** (Open/Closed) | Dispatch is data; extend by adding handlers, not by editing dispatch code |
| **S** (Single Resp.) | `allowOrphans: false` rejects unreferenced handlers — every registered handler must have a job |

## What it catches

| Rule | Failure |
|---|---|
| R1 | `baseDispatch` references a handler not in `handlers` |
| R2 | `dispatch[*]` references a handler not in `handlers` |
| R3 | A single list contains a duplicate handler name |
| R4 | (when `tagSet` is provided) `dispatch` key is not a member of `tagSet` |
| R5 | A handler is missing a `handlerShape.requiredFields` entry; or `name` disagrees with the registry key; or `detect` is not a function |
| R6 | (when `allowOrphans: false`) a handler is registered but no dispatch list references it |
| W1 | (warning, when `allowOrphans` is true) same orphan case — reported as warning |

## Usage

```js
const { validateDispatchRegistry } = require('factories/dispatchRegistryValidator');

const result = validateDispatchRegistry({
  baseDispatch: ['fooDetector', 'barDetector'],
  dispatch: {
    implement: ['fooDetector', 'commitStall'],
    commit: ['barDetector'],
  },
  handlers: {
    fooDetector: { name: 'fooDetector', detect: () => ({ hit: false }) },
    barDetector: { name: 'barDetector', detect: () => ({ hit: false }) },
    commitStall: { name: 'commitStall', detect: () => ({ hit: false }) },
  },
  tagSet: new Set(['implement', 'commit', 'check']),
});
assert.equal(result.valid, true, result.errors.join('\n'));
```

### Example caller: maestro phase registry

Maestro produces a `{ BASE, PHASES, DETECTORS, STEPS }` tuple. It maps
onto this validator's surface as:

| Maestro field | Validator parameter |
|---|---|
| `BASE` (or `{ detectors: [...] }`) | `baseDispatch` |
| `PHASES` | `dispatch` |
| `DETECTORS` | `handlers` |
| `Object.values(STEPS)` | `tagSet` (wrapped in a `Set`) |

The validator's own test suite self-tests against the real maestro +
/work registries when those files exist on disk; nothing in the
validator module itself imports them.

## Why this lives in `factories/`

It's a structural check on registry shape, independent of any runtime.
Same domain as `registryValidator` (which validates step-machine + retry
graphs), so the two related validators land together.

## What this validator does NOT do

- Doesn't enforce policy values (e.g. budget limits) — those are
  domain-specific. Add a separate test if you want one.
- Doesn't check escalation/priority semantics.
- Doesn't replace handler-level unit tests. It only validates the
  wiring.
