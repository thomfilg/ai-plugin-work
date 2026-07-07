'use strict';

/**
 * ticket-provider-prompts.js
 *
 * Provider-specific prompt/tool builders extracted from ticket-provider.js:
 * fetch/related/transition/create prompts plus the MCP allowlist and the
 * create-ticket agent type. Pure string assembly — no filesystem or git
 * access. Consumed exclusively through the ticket-provider.js facade so
 * callers keep a single require surface.
 */

function getFetchTicketPrompt(ticketId, providerConfig) {
  if (!providerConfig) return null;
  switch (providerConfig.provider) {
    case 'jira':
      return (
        'Fetch Jira ticket ' +
        ticketId +
        ' using mcp__atlassian__jira_get_issue with issue_key "' +
        ticketId +
        '". Return the ticket summary, description, status, and acceptance criteria.'
      );
    case 'linear':
      return (
        'Fetch Linear issue ' +
        ticketId +
        ' using mcp__linear__get_issue with id "' +
        ticketId +
        '". Return the issue title, description, status, and any labels or acceptance criteria.'
      );
    case 'github':
      return (
        'Fetch GitHub issue ' +
        ticketId +
        ' by running: gh issue view ' +
        ticketId.replace(/^#/, '') +
        ' --json title,body,state,labels. Return the issue title, body, state, and labels.'
      );
    case 'none':
      return null;
    default:
      return null;
  }
}

function relatedTicketsSchemaBlock(ticketId, manifestPath) {
  return (
    'Schema (write this exact shape; arrays may be empty but must exist):\n' +
    '{\n' +
    '  "self":      { "id": "' +
    ticketId +
    '", "title": "...", "status": "..." },\n' +
    '  "parent":    { "id": "...", "title": "...", "status": "...", "scope": "..." } | null,\n' +
    '  "siblings":  [ { "id": "...", "title": "...", "status": "...", "scope": "...", "prNumber": 1234, "surfaces": ["lib/x.ts", "app/api/.../y.ts"] } ],\n' +
    '  "blockedBy": [ { "id": "...", "title": "...", "status": "...", "scope": "...", "prNumber": null } ],\n' +
    '  "dependsOn": [ { "id": "...", "title": "...", "status": "...", "scope": "...", "prNumber": null } ],\n' +
    '  "relatedTo": [ { "id": "...", "title": "...", "status": "...", "scope": "...", "prNumber": null } ],\n' +
    '  "fetchedAt": "<ISO-8601 timestamp NOW>"\n' +
    '}\n' +
    '\n' +
    'Rules:\n' +
    '- **Exclude the current ticket (' +
    ticketId +
    ') from every bucket — siblings, blockedBy, dependsOn, relatedTo, and parent.** A ticket is never its own sibling, blocker, dependency, related-to, or parent. Likewise, never write `_related/' +
    ticketId +
    '.md` — a ticket has no related-file representation of itself.\n' +
    '- `parent` is null when this ticket has no parent. Otherwise populate from the parent link (and it must not be ' +
    ticketId +
    ').\n' +
    '- `siblings` = children of the same parent, EXCLUDING ' +
    ticketId +
    '. If there is no parent, leave it [].\n' +
    '- `blockedBy` / `dependsOn` / `relatedTo` come from the ticket-system link types, each EXCLUDING ' +
    ticketId +
    '.\n' +
    "- **`scope` (REQUIRED on every linked entry):** read each linked ticket's full description, then distill it into a focused one-to-three-sentence summary of WHAT THAT TICKET OWNS — files, endpoints, schemas, layers. This is the field downstream agents use to decide sibling ownership when no PR is merged yet.\n" +
    '  - Good: `"scope": "Owns the new `externalAssets.listDownstreamDashboards` tRPC procedure on viewsRouter and its Zod schema. Adds `select`+`where` for Dashboard rows. No UI changes."`\n' +
    '  - Bad (too vague): `"scope": "Backend work for downstream dashboards"`\n' +
    '  - Bad (full body): pasting the entire ticket description verbatim.\n' +
    '  - Bad (too narrow): `"scope": "Wire to explore.list"` without naming any concrete surface.\n' +
    '  - Keep `scope` ≤ ~400 characters. Strip implementation noise (deadlines, status updates, side-comments) — keep only ownership signals.\n' +
    '- For every sibling AND parent with a merged PR, populate `surfaces` with the list of files changed in that PR (run `gh pr diff <N> --name-only` and copy the file paths). For unshipped tickets, leave `surfaces: []` — `scope` is what carries ownership info in that case.\n' +
    '- Write the JSON to: ' +
    manifestPath +
    '\n' +
    '- After writing, validate by reading it back and parsing.'
  );
}

function jiraRelatedTicketsPrompt(ticketId, schemaBlock) {
  return (
    'Fetch related tickets for Jira issue ' +
    ticketId +
    ' and write a related-tickets manifest.\n\n' +
    'Steps:\n' +
    '1. Use mcp__atlassian__jira_get_issue with issue_key "' +
    ticketId +
    '" and fetch the full payload including the `issuelinks` field and the `parent` field.\n' +
    '2. Parse:\n' +
    '   - `parent`: from fields.parent if present.\n' +
    '   - `siblings`: search for siblings via JQL `parent = "' +
    ticketId +
    '"`\'s parent — use mcp__atlassian__jira_search with JQL `parent = "<parent-key>"` and exclude ' +
    ticketId +
    '.\n' +
    '   - `blockedBy`: issuelinks where this issue `is blocked by`.\n' +
    '   - `dependsOn`: issuelinks where this issue `depends on`.\n' +
    '   - `relatedTo`: issuelinks where the link type is `relates to`.\n' +
    "3. For each linked ticket with a merged PR, find the PR number from the issue's remote links or development field, then run `gh pr diff <N> --name-only` to populate `surfaces`.\n\n" +
    schemaBlock
  );
}

function linearRelatedTicketsPrompt(ticketId, schemaBlock) {
  return (
    'Fetch related issues for Linear issue ' +
    ticketId +
    ' and write a related-tickets manifest.\n\n' +
    'Steps:\n' +
    '1. Use mcp__linear__get_issue with id "' +
    ticketId +
    '" and capture: `parent`, `children`, and `relations` (each relation has a `type`: `blocks`, `blocked_by`, `duplicate`, `related`, …).\n' +
    '2. Parse:\n' +
    '   - `parent`: from the parent field.\n' +
    '   - `siblings`: if there is a parent, list its other children (use mcp__linear__get_issue on the parent and read `children`, exclude ' +
    ticketId +
    ').\n' +
    '   - `blockedBy`: relations where type is `blocked_by` (or the inverse of `blocks`).\n' +
    "   - `dependsOn`: relations where type is `blocks` and the target depends on this issue — use the same field interpreted per Linear's schema.\n" +
    '   - `relatedTo`: relations where type is `related`.\n' +
    '3. For each linked issue with a merged PR (Linear surfaces these via the `attachments` or external links), run `gh pr diff <N> --name-only` to populate `surfaces`.\n\n' +
    schemaBlock
  );
}

function githubRelatedTicketsPrompt(ticketId, schemaBlock) {
  return (
    'Fetch related issues for GitHub issue ' +
    ticketId +
    ' and write a related-tickets manifest.\n\n' +
    'Steps:\n' +
    '1. Run `gh issue view ' +
    ticketId.replace(/^#/, '') +
    ' --json title,body,labels,milestone` and capture the body.\n' +
    '2. Parse the body for these conventions (case-insensitive):\n' +
    '   - `Parent: #N` or `Parent issue: #N` → `parent`.\n' +
    '   - `Blocked by: #N, #M` → each goes into `blockedBy`.\n' +
    '   - `Depends on: #N` → `dependsOn`.\n' +
    '   - `Related: #N` or `Related to: #N` → `relatedTo`.\n' +
    '3. For siblings: if there is a parent, run `gh issue view <parent-N> --json body` and parse its body for a checklist of sub-issues (`- [ ] #N`, `- [x] #N`), excluding ' +
    ticketId +
    '.\n' +
    '4. For each linked issue, run `gh issue view <N> --json state,title` to populate status, and `gh pr list --search "linked-issue:<N>" --state merged --json number` to find the merged PR. If a PR exists, run `gh pr diff <N> --name-only` to populate `surfaces`.\n\n' +
    schemaBlock
  );
}

function getRelatedTicketsPrompt(ticketId, providerConfig, manifestPath) {
  if (!providerConfig) return null;
  const schemaBlock = relatedTicketsSchemaBlock(ticketId, manifestPath);
  switch (providerConfig.provider) {
    case 'jira':
      return jiraRelatedTicketsPrompt(ticketId, schemaBlock);
    case 'linear':
      return linearRelatedTicketsPrompt(ticketId, schemaBlock);
    case 'github':
      return githubRelatedTicketsPrompt(ticketId, schemaBlock);
    case 'none':
      return null;
    default:
      return null;
  }
}

function getTransitionPrompt(ticketId, status, providerConfig) {
  if (!providerConfig) return null;
  switch (providerConfig.provider) {
    case 'jira':
      return (
        'Transition Jira ticket ' +
        ticketId +
        ' to "' +
        status +
        '" (idempotent). Use mcp__atlassian__jira_get_transitions to get available transitions for ' +
        ticketId +
        ', then use mcp__atlassian__jira_transition_issue to move it to "' +
        status +
        '". If already in that status, report success.'
      );
    case 'linear':
      return (
        'Transition Linear issue ' +
        ticketId +
        ' to "' +
        status +
        '" using mcp__linear__save_issue with id "' +
        ticketId +
        '" and state "' +
        status +
        '". If already in that status, report success.'
      );
    case 'github':
    case 'none':
      return null;
    default:
      return null;
  }
}

function getCreateTicketPrompt(description, providerConfig) {
  if (!providerConfig) return null;
  switch (providerConfig.provider) {
    case 'jira':
      return 'Create a Jira ticket from this description: "' + description + '"';
    case 'linear':
      return (
        'Create a Linear issue from this description: "' +
        description +
        '" using mcp__linear__save_issue with a clear title and the description as the body.'
      );
    case 'github':
      return (
        'Create a GitHub issue from this description: "' +
        description +
        '" by running: gh issue create --title "<title>" --body "<body>"'
      );
    case 'none':
      return null;
    default:
      return null;
  }
}

function getAllowedMcpTools(providerConfig) {
  if (!providerConfig) return [];
  switch (providerConfig.provider) {
    case 'jira':
      return [
        'mcp__atlassian__jira_get_issue',
        'mcp__atlassian__jira_get_transitions',
        'mcp__atlassian__jira_transition_issue',
      ];
    case 'linear':
      return ['mcp__linear__get_issue', 'mcp__linear__save_issue', 'mcp__linear__list_issues'];
    case 'github':
    case 'none':
      return [];
    default:
      return [];
  }
}

function getCreateTicketAgentType(providerConfig) {
  if (!providerConfig) return 'general-purpose';
  switch (providerConfig.provider) {
    case 'jira':
      return 'jira-task-creator';
    case 'linear':
    case 'github':
      return 'general-purpose';
    case 'none':
      return null;
    default:
      return 'general-purpose';
  }
}

module.exports = {
  getFetchTicketPrompt,
  getRelatedTicketsPrompt,
  getTransitionPrompt,
  getCreateTicketPrompt,
  getAllowedMcpTools,
  getCreateTicketAgentType,
};
