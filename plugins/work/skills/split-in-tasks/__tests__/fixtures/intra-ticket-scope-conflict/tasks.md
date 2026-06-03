# Tasks (intra-ticket scope conflict fixture — ECHO-5538 shape)

_Invalid fixture: Task 3 owns `components/X.tsx` via `### Files in scope`, but Tasks 1, 2, and 4 each list the same file under `### Files explicitly out of scope`. The intra-ticket validator must flag all 3 conflicts._

## Task 1 — Add helper A

### Type
chore

### Files in scope
- `lib/a.ts`

### Files explicitly out of scope
- `components/X.tsx`

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

### Files explicitly out of scope
- `components/X.tsx`

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

### Files explicitly out of scope
- `components/X.tsx`

### Deliverables
- [ ] 4.1 **GREEN:** add helper D
  - Test: `helperD()` returns 4

### Test Command
```bash
CHANGED_FILES="lib/d.test.ts" eval "$TEST_UNIT_COMMAND"
```
