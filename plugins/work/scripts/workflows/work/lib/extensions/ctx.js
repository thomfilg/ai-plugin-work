/**
 * ctx factory — Phase 1 extension context.
 *
 * Builds the per-dispatch context object handed to every extension handler.
 * Phase 1 supports only the passthrough/injectContext surface; the richer
 * Phase 2 methods (`handled`, `block`, `callTool`) intentionally throw
 * `PhaseNotReadyError` so extensions written today fail loudly rather than
 * silently no-op.
 *
 * Phase 1 payload contract (per event):
 *   - OnSessionStart    : { ticketId, tasksDir, repoRoot }
 *   - OnTicketResolved  : { ticketId, ticket, tasksDir, repoRoot }
 *   - OnStepEnter/Exit  : { ticketId, step, tasksDir, repoRoot }
 *
 * Covers Task 2 acceptance criteria (R2, R5, R10, G7).
 */

'use strict';

/**
 * Thrown by Phase 2 ctx methods (`handled`, `block`, `callTool`) when invoked
 * during Phase 1. Named so callers can `err.name === 'PhaseNotReadyError'`.
 */
class PhaseNotReadyError extends Error {
  /** @param {string} [message] */
  constructor(message) {
    super(message || 'Phase 2 ctx method not available in Phase 1');
    this.name = 'PhaseNotReadyError';
  }
}

/**
 * Build a fresh ctx for a single dispatch.
 *
 * @param {{ event: string, payload: object }} args
 * @returns {{
 *   event: string,
 *   payload: object,
 *   passthrough: () => void,
 *   injectContext: (text: string) => void,
 *   getInjectedContext: () => string,
 *   handled: (payload: object) => never,
 *   block: (payload: object) => never,
 *   callTool: (name: string, args: object) => never,
 * }}
 */
function createCtx({ event, payload, tasksDir }) {
  /** @type {string[]} */
  const injected = [];

  return {
    event,
    payload,
    tasksDir,

    /**
     * Explicit no-op sentinel — signals "I saw this event and chose to do
     * nothing". Distinct from "forgot to handle" so reviewers can audit.
     * Phase 1 payload: none.
     */
    passthrough() {
      // intentional no-op
    },

    /**
     * Queue context text to be surfaced to the user after dispatch.
     * Multiple calls concatenate in insertion order.
     * Phase 1 payload: a single string.
     *
     * @param {string} text
     */
    injectContext(text) {
      injected.push(String(text));
    },

    /**
     * Return all injected context concatenated in insertion order (joined
     * with a newline). Empty string if nothing was injected.
     * Phase 1 payload: none.
     *
     * @returns {string}
     */
    getInjectedContext() {
      return injected.join('\n');
    },

    /**
     * Phase 2 only — declare the event fully handled. Throws in Phase 1.
     * Phase 2 payload: `{ result?: unknown }`.
     *
     * @param {object} _payload
     * @throws {PhaseNotReadyError}
     */
    handled(_payload) {
      throw new PhaseNotReadyError('ctx.handled() is a Phase 2 method');
    },

    /**
     * Phase 2 only — block the workflow with a reason. Throws in Phase 1.
     * Phase 2 payload: `{ reason: string }`.
     *
     * @param {object} _payload
     * @throws {PhaseNotReadyError}
     */
    block(_payload) {
      throw new PhaseNotReadyError('ctx.block() is a Phase 2 method');
    },

    /**
     * Phase 2 only — invoke a host tool from an extension. Throws in Phase 1.
     * Phase 2 payload: `(toolName: string, toolArgs: object)`.
     *
     * @param {string} _name
     * @param {object} _args
     * @throws {PhaseNotReadyError}
     */
    callTool(_name, _args) {
      throw new PhaseNotReadyError('ctx.callTool() is a Phase 2 method');
    },
  };
}

module.exports = { createCtx, PhaseNotReadyError };
