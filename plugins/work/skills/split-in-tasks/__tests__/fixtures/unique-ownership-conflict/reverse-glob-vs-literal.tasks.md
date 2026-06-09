# Tasks (unique-ownership conflict fixture — reverse glob vs literal)

_Invalid fixture: Task 1 owns the literal `app/api/routers/users.ts` and Task 2 owns the glob `app/api/routers/**`. The glob in the later peer covers the earlier literal — the unique-ownership validator must flag this reverse-direction overlap symmetrically._

## Task 1 — Own users router

### Type
wiring

### Files in scope
- `app/api/routers/users.ts`

### Deliverables
- [ ] 1.1 **GREEN:** own users router
  - Test: users router exports something

### Test Command
```bash
CHANGED_FILES="app/api/routers/users.test.ts" eval "$TEST_UNIT_COMMAND"
```

---

## Task 2 — Sweep routers

### Type
wiring

### Files in scope
- `app/api/routers/**`

### Deliverables
- [ ] 2.1 **GREEN:** sweep routers
  - Test: covers routers

### Test Command
```bash
CHANGED_FILES="app/api/routers/index.test.ts" eval "$TEST_UNIT_COMMAND"
```
