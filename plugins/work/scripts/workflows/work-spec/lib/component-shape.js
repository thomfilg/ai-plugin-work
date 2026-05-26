/**
 * component-shape.js — parse the `## Component Shape Decision` table out of
 * spec.md so both the spec reuse_audit gate and the tasks draft phase can
 * agree on what the decision says.
 *
 * The table shape (as documented in agents/spec-writer.md):
 *
 *   | Proposed component | Data inputs | Other pages could use the generic part? | Decision | Rationale |
 *   |---|---|---|---|---|
 *   | `UsersTable` | `users[]` | Yes — ... | **Split: Generic `Table` + Specific `UsersTable`** | ... |
 *
 * Decision classification:
 *   - `genericSplit`  → cell contains "Generic" (typically "Split: Generic <X> + Specific <Y>")
 *   - `specificOnly`  → cell contains "Specific" without "Generic"
 *   - `na`            → cell contains "N/A"
 *   - `unknown`       → anything else (gate may reject)
 *
 * The parser is tolerant — it strips backticks/bold/em formatting before
 * matching so authors don't have to copy the example markdown verbatim.
 */

'use strict';

const fs = require('node:fs');

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function sliceSection(text, headerRe) {
  const m = text.match(headerRe);
  if (!m) return null;
  const after = text.slice(m.index + m[0].length);
  const next = after.match(/^##\s/m);
  return next ? after.slice(0, next.index) : after;
}

function stripMd(cell) {
  return cell
    .replace(/\*\*/g, '')
    .replace(/[*_]/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSeparatorRow(row) {
  return /^\s*\|?\s*[:|\s-]+\|?\s*$/.test(row);
}

function splitRow(row) {
  let trimmed = row.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((c) => c.trim());
}

function classifyDecision(decisionText) {
  const clean = stripMd(decisionText);
  if (/\bN\/?A\b/i.test(clean)) return 'na';
  const hasGeneric = /\bgeneric\b/i.test(clean);
  const hasSpecific = /\bspecific\b/i.test(clean);
  if (hasGeneric) return 'genericSplit'; // "Split: Generic + Specific" and bare "Generic" both count
  if (hasSpecific) return 'specificOnly';
  return 'unknown';
}

/**
 * Extract the shared component name from a Generic-split decision cell.
 * Example: "Split: Generic `Table` + Specific `UsersTable`" → "Table".
 * Returns null if the format is too loose to extract reliably.
 */
function extractGenericName(decisionText) {
  // Prefer explicit Generic `<Name>` pattern (with backticks before strip).
  const m = decisionText.match(/Generic\s+`([^`]+)`/i);
  if (m) return m[1].trim();
  // Fallback: first identifier after the word "Generic".
  const clean = stripMd(decisionText);
  const m2 = clean.match(/Generic\s+([A-Za-z][A-Za-z0-9]*)/i);
  return m2 ? m2[1] : null;
}

/**
 * Extract the specific (page-bound) component name.
 * Example: "Split: Generic `Table` + Specific `UsersTable`" → "UsersTable".
 */
function extractSpecificName(decisionText) {
  const m = decisionText.match(/Specific\s+`([^`]+)`/i);
  if (m) return m[1].trim();
  const clean = stripMd(decisionText);
  const m2 = clean.match(/Specific\s+([A-Za-z][A-Za-z0-9]*)/i);
  return m2 ? m2[1] : null;
}

/**
 * Extract the component-family stem (e.g. "Lineage" from "ExternalAssetLineage").
 * Naive: split CamelCase, drop common role suffixes, return the last meaningful
 * token. Used by the cross-spec duplication scan.
 */
const ROLE_SUFFIXES = new Set([
  'Table',
  'Sidebar',
  'Panel',
  'Modal',
  'Dialog',
  'Dropdown',
  'Breadcrumb',
  'List',
  'Grid',
  'Row',
  'Card',
  'Tab',
  'Tabs',
  'Form',
  'Field',
  'Header',
  'Footer',
  'Tree',
  'Filter',
  'Banner',
  'Toast',
  'Tooltip',
  'Menu',
  'Drawer',
]);

function extractStem(name) {
  if (!name) return null;
  const tokens = name
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .split(/(?=[A-Z])|\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  // Drop trailing role suffix if present.
  const last = tokens[tokens.length - 1];
  if (ROLE_SUFFIXES.has(last) && tokens.length > 1) {
    return tokens[tokens.length - 2];
  }
  return last;
}

/**
 * Parse the Component Shape Decision section from a spec's text.
 * Returns { found: bool, rows: [...], separatorSeen: bool }.
 */
function parseShapeSection(specText) {
  const section = sliceSection(specText, /^##\s+Component Shape Decision(?=\s|$)/im);
  if (section == null) return { found: false, rows: [], separatorSeen: false };
  const rows = [];
  let sawHeader = false;
  let separatorSeen = false;
  for (const line of section.split('\n')) {
    if (!/^\s*\|/.test(line)) continue;
    const pipes = (line.match(/\|/g) || []).length;
    if (pipes < 5) continue; // require at least 5 columns (= 5+ pipes when both edges present)
    if (!sawHeader) {
      sawHeader = true;
      continue;
    }
    if (isSeparatorRow(line)) {
      separatorSeen = true;
      continue;
    }
    const cells = splitRow(line);
    if (cells.length < 5) continue;
    const [proposed, dataInputs, couldBeAgnostic, decision, rationale] = cells;
    const kind = classifyDecision(decision);
    rows.push({
      proposed: stripMd(proposed),
      proposedRaw: proposed,
      dataInputs: stripMd(dataInputs),
      couldBeAgnostic: stripMd(couldBeAgnostic),
      decision: stripMd(decision),
      decisionRaw: decision,
      rationale: stripMd(rationale),
      rationaleRaw: rationale,
      kind,
      isGenericSplit: kind === 'genericSplit',
      isSpecificOnly: kind === 'specificOnly',
      isNA: kind === 'na',
      genericName: kind === 'genericSplit' ? extractGenericName(decision) : null,
      specificName: kind === 'genericSplit' ? extractSpecificName(decision) : null,
      stem: extractStem(stripMd(proposed)),
    });
  }
  return { found: true, rows, separatorSeen };
}

function parseShapeFromSpec(specPath) {
  const text = readFile(specPath);
  if (text == null) return { found: false, rows: [], separatorSeen: false };
  return parseShapeSection(text);
}

module.exports = {
  parseShapeSection,
  parseShapeFromSpec,
  classifyDecision,
  extractGenericName,
  extractSpecificName,
  extractStem,
  stripMd,
  sliceSection,
};
