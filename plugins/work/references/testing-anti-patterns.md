# Testing Anti-Patterns

This reference catalogs common testing anti-patterns that undermine code quality. Each anti-pattern includes a gate function describing how to detect and prevent it during development and review.

## Testing mock behavior instead of real behavior

When tests verify that mocks were called correctly rather than verifying actual system behavior, the tests become tautological. They pass by definition because they only confirm the test setup, not the production code. A test suite full of mock-verification assertions can achieve 100% coverage while catching zero real bugs.

### Gate function

Before approving a test, ask: "If I delete the production code this test covers and replace it with a stub that satisfies the mocks, does the test still pass?" If yes, the test is testing mock behavior, not real behavior. Require at least one assertion on an observable output (return value, side effect, state change) that would fail if the production logic were removed.

## Adding test-only methods to production code

When production classes or modules expose methods, properties, or flags solely to make testing easier (e.g., `_getInternalState()`, `testMode` flags, `resetForTesting()`), the production code becomes coupled to test infrastructure. This leaks test concerns into production, increases surface area for bugs, and creates maintenance burden.

### Gate function

Search production source files for symbols containing "test", "mock", "stub", or "spec" in their names. If any exist and are not part of a legitimate public API, flag them. Production code should be testable through its public interface. If it is not, the design needs refactoring (dependency injection, strategy pattern, or interface extraction), not test-only backdoors.

## Mocking without understanding what is being mocked

When developers mock a dependency without understanding its contract, the mock becomes a fiction. It returns values the real dependency would never return, omits error cases the real dependency raises, and silently diverges from the real behavior over time. Tests pass against the fiction while the real integration is broken.

### Gate function

For every mock in a test file, verify: (1) the mock's return values match the real dependency's documented or observed behavior, (2) the mock covers at least one error/failure case from the real dependency, and (3) the mock is updated when the real dependency's interface changes. If a mock was copy-pasted from another test without verification, flag it.

## Incomplete mocks that hide real failures

When a mock replaces a dependency but only implements the happy path, the test suite becomes blind to failure modes. The real dependency may throw, return null, timeout, or return malformed data, but the mock always returns a perfect response. Production code that lacks error handling passes all tests and fails in production.

### Gate function

For each mocked dependency, list the failure modes of the real dependency (throws, returns null, returns error codes, times out). Verify that at least one test exercises each failure mode through the mock. If the mock has no failure-mode tests, the test suite has a coverage gap that must be addressed before merge.

## Integration tests treated as an afterthought

When integration tests are deferred, skipped, or written as shallow wrappers around unit tests, the system's actual wiring is never verified. Components that pass all unit tests individually can fail catastrophically when composed. Database queries, HTTP calls, message queues, and file I/O must be tested with real (or realistic) infrastructure.

### Gate function

For any feature that crosses a system boundary (database, HTTP, file system, message queue), verify that at least one integration test exercises the real boundary. If all tests for a boundary-crossing feature use mocks exclusively, flag the gap. The integration test does not need to cover every case, but it must prove that the real wiring works for at least the primary happy path and one failure path.

