# Tasks (ECHO-5361 clean fixture)

_Negative control for Pass A: Task 1 deletes `a.ts`, Task 2 RED asserts behavior on a different file `b.ts`. No chronological collision — Pass A must stay silent._

## Task 1 — Remove a.ts

### Type
chore

### Files in scope
- `a.ts`

### Deliverables
- [ ] 1.1 **GREEN:** delete `a.ts` from the working tree
  - Test: file `a.ts` no longer exists

---

## Task 2 — Add behavior on b.ts

### Type
wiring

### Files in scope
- `b.ts`

### Deliverables
- [ ] 2.1 **RED:** assert `transform(b)` returns the expected mapped value
  - Test: `transform(b)` returns `{ ok: true }` (currently throws)
- [ ] 2.2 **GREEN:** implement `transform` in `b.ts`
  - Test: assertion from 2.1 now passes
