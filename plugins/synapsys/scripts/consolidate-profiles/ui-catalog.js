'use strict';

/**
 * ui-catalog profile (spec literal — GH-442).
 *
 * Parses `packages/ui/components-catalog.md` into atomic items, then
 * derives `trigger_pretool_content` matchers from one of three rule
 * groups:
 *
 *   1. RAW_HTML_TAG — components that wrap a single HTML primitive
 *      get a tag matcher (e.g. Button → `<button\b`).
 *   2. NO_PRIMITIVE_LIST — components without a single HTML primitive
 *      (DataGrid, Toast, Sidebar, …) get an MUI-import escape-hatch
 *      pair of matchers (AND-matched at runtime by GH-441's matcher).
 *   3. TYPOGRAPHY — Text/Heading/Paragraph emit a sentinel content
 *      matcher; the driver merges them post-hoc into one
 *      `ui-component-typography` memory with content matcher
 *      `<(p|h[1-6]|span)\b`.
 *
 * Components in none of the three groups return null (skipped — the
 * profile is purely additive; future maps may absorb them).
 */

const RAW_HTML_TAG = {
  Button: '<button\\b',
  Input: '<input\\b',
  Select: '<select\\b',
  Table: '<table\\b',
  Dialog: '<dialog\\b',
  Form: '<form\\b',
  Textarea: '<textarea\\b',
  Link: '<a\\b',
  Image: '<img\\b',
  List: '<(ul|ol)\\b',
  ListItem: '<li\\b',
  Span: '<span\\b',
  Div: '<div\\b',
};

const TYPOGRAPHY = new Set(['Text', 'Heading', 'Paragraph']);

const NO_PRIMITIVE_LIST = new Set([
  'DataGrid',
  'CodeEditor',
  'Sidebar',
  'Toast',
  'CommandPalette',
  'VirtualList',
]);

// Driver inspects trigger_pretool_content[0] === TYPOGRAPHY_SENTINEL to
// identify and merge typography memories into one.
const TYPOGRAPHY_SENTINEL = '__TYPOGRAPHY__';

const FIELD_LINE_RE = /^\*\*(Purpose|Use Cases|Features|Location|Docs)\*\*:\s*(.+)$/;
const FIELD_KEY = {
  Purpose: 'purpose',
  'Use Cases': 'useCases',
  Features: 'features',
  Location: 'location',
  Docs: 'docsPath',
};
const STRIP_BACKTICKS_KEYS = new Set(['location', 'docsPath']);
const NAME_RE = /^[A-Za-z0-9_]+$/;

function stripBackticks(value) {
  return value.replace(/^`+|`+$/g, '').trim();
}

function parse(text /* , sourcePath */) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const blocks = text.split(/^### /m).slice(1);
  const items = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const name = (lines[0] || '').trim();
    if (!name) continue;
    const item = {
      name,
      purpose: '',
      useCases: '',
      features: '',
      location: '',
      docsPath: '',
    };
    for (const line of lines.slice(1)) {
      const m = FIELD_LINE_RE.exec(line.trim());
      if (!m) continue;
      const key = FIELD_KEY[m[1]];
      const raw = m[2].trim();
      item[key] = STRIP_BACKTICKS_KEYS.has(key) ? stripBackticks(raw) : raw;
    }
    items.push(item);
  }
  return items;
}

function buildBody(item) {
  return [
    `# ${item.name}`,
    '',
    `**Purpose**: ${item.purpose}`,
    `**Use Cases**: ${item.useCases}`,
    `**Features**: ${item.features}`,
    `**Location**: ${item.location}`,
    `**Docs**: ${item.docsPath}`,
  ].join('\n');
}

function muiMatchers(name) {
  if (!NAME_RE.test(name)) return null;
  return ['from\\s+[\'"]@mui/material[\'"]', `import\\s+\\{[^}]*\\b${name}\\b`];
}

function deriveContent(name) {
  if (TYPOGRAPHY.has(name)) return [TYPOGRAPHY_SENTINEL];
  if (Object.prototype.hasOwnProperty.call(RAW_HTML_TAG, name)) {
    return [RAW_HTML_TAG[name]];
  }
  if (NO_PRIMITIVE_LIST.has(name)) return muiMatchers(name);
  return null;
}

function toMemory(item /* , ctx */) {
  if (!item || typeof item.name !== 'string' || !item.name) return null;
  const content = deriveContent(item.name);
  if (!content) return null;
  return {
    name: `ui-component-${item.name}`,
    events: ['PreToolUse'],
    trigger_pretool: ['Edit:.*\\.tsx', 'Write:.*\\.tsx'],
    trigger_pretool_content: content,
    inject: 'full',
    body: buildBody(item),
  };
}

module.exports = {
  name: 'ui-catalog',
  description:
    'Parses packages/ui/components-catalog.md into per-component memories using a raw-HTML-tag map, MUI escape-hatch matchers, and a typography-merge sentinel.',
  sources: ['packages/ui/components-catalog.md'],
  parse,
  toMemory,
  RAW_HTML_TAG,
  NO_PRIMITIVE_LIST,
  TYPOGRAPHY,
  TYPOGRAPHY_SENTINEL,
};
