# Tasks (intra-ticket scope conflict fixture — CORRECTED)

_Corrected version: Tasks 1, 2, and 4 no longer list `components/X.tsx` as out-of-scope. Task 3 still owns it. The intra-ticket validator must return zero errors._

## Task 1 — Add helper A

### Type
chore

### Files in scope
- `lib/a.ts`

### Deliverables
- [ ] 1.1 **GREEN:** add helper A
  - Test: `helperA()` returns 1

### Test Command
```bash
CHANGED_FILES="lib/a.test.ts" eval "$TEST_UNIT_COMMAND"
```

---

## Task 2 — Add helper B

### Type
chore

### Files in scope
- `lib/b.ts`

### Deliverables
- [ ] 2.1 **GREEN:** add helper B
  - Test: `helperB()` returns 2

### Test Command
```bash
CHANGED_FILES="lib/b.test.ts" eval "$TEST_UNIT_COMMAND"
```

---

## Task 3 — Wire components/X.tsx

### Type
wiring

### Files in scope
- `components/X.tsx`

### Deliverables
- [ ] 3.1 **GREEN:** wire X
  - Test: `<X />` renders

### Test Command
```bash
CHANGED_FILES="components/X.test.tsx" eval "$TEST_UNIT_COMMAND"
```

---

## Task 4 — Add helper D

### Type
chore

### Files in scope
- `lib/d.ts`

### Deliverables
- [ ] 4.1 **GREEN:** add helper D
  - Test: `helperD()` returns 4

### Test Command
```bash
CHANGED_FILES="lib/d.test.ts" eval "$TEST_UNIT_COMMAND"
```
