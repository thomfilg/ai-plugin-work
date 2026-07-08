# Tasks (ECHO-5362 regression fixture)

_Reproduces the ECHO-5362 cross-ticket contract divergence: one task consumes `deleter-select-field.tsx` (listed out of scope, owned by a sibling ticket) which reads `data.map`, while another task in this ticket produces `{deleters: [...]}` from a router stub. The shapes diverge._

## Task 1 — Wire router to expose deleters

### Type
wiring

### Files in scope
- `router.ts`

### Files explicitly out of scope
- `deleter-select-field.tsx` — owned by ECHO-5352

### Deliverables
- [ ] 1.1 **GREEN:** implement `getDeleters()` in `router.ts` returning `{deleters: [...]}`
  - Test: `getDeleters()` returns an object with a `deleters` array

---

## Task 2 — Integration: deleter-select-field consumes router output

### Type
integration

### Files in scope
- `router.ts`
- `deleter-select-field.tsx`

### Files explicitly out of scope
- `deleter-select-field.tsx` — owned by ECHO-5352 (we only read it here)

### Deliverables
- [ ] 2.1 **RED:** assert `<DeleterSelectField data={getDeleters()} />` renders without throwing
  - Test: rendering throws today because the component calls `data.map` on a non-array shape
- [ ] 2.2 **GREEN:** reshape router payload to match consumer
  - Test: render passes
