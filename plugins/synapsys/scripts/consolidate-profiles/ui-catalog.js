'use strict';

/**
 * ui-catalog profile — parses packages/ui/components-catalog.md into atomic
 * component items. `toMemory` is intentionally a null placeholder in this
 * task (Task 3); the raw-HTML-tag map, MUI escape-hatch, and typography
 * sentinel are added in Task 4.
 */

const FIELD_LINE_RE = /^\*\*(Purpose|Use Cases|Features|Location|Docs)\*\*:\s*(.+)$/;

const FIELD_KEY = {
  Purpose: 'purpose',
  'Use Cases': 'useCases',
  Features: 'features',
  Location: 'location',
  Docs: 'docsPath',
};

/**
 * Strip surrounding backticks from inline-code values (location/docsPath
 * in the catalog are wrapped in backticks).
 */
function stripBackticks(value) {
  return value.replace(/^`+|`+$/g, '').trim();
}

/**
 * Parse one `### ` block (with the leading `### ` already stripped) into a
 * structured item. Returns null when the block has no recognisable name line.
 */
function parseBlock(block) {
  const lines = block.split('\n');
  const name = (lines.shift() || '').trim();
  if (!name) return null;

  const item = {
    name,
    purpose: '',
    useCases: '',
    features: '',
    location: '',
    docsPath: '',
  };

  for (const line of lines) {
    const match = FIELD_LINE_RE.exec(line.trim());
    if (!match) continue;
    const key = FIELD_KEY[match[1]];
    const raw = match[2].trim();
    item[key] = key === 'location' || key === 'docsPath' ? stripBackticks(raw) : raw;
  }

  return item;
}

function parse(text /* , sourcePath */) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const blocks = text.split(/^### /m).slice(1);
  const items = [];
  for (const block of blocks) {
    const item = parseBlock(block);
    if (item) items.push(item);
  }
  return items;
}

/**
 * Raw HTML primitive map — component names whose runtime equivalent is a
 * single HTML tag. Used to derive a `<tag\b` content matcher.
 */
const RAW_HTML_TAG = Object.freeze({
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
});

/**
 * Typography names that collapse into a single `ui-component-typography`
 * memory at the driver layer. The profile emits a sentinel marker; the
 * driver (Task 6) recognises it and merges.
 */
const TYPOGRAPHY_NAMES = new Set(['Text', 'Heading', 'Paragraph']);
const { TYPOGRAPHY_SENTINEL } = require('./_constants');

/**
 * Components with no single raw-HTML equivalent — these trigger on the
 * `@mui/material` import escape-hatch instead.
 */
const NO_PRIMITIVE_LIST = new Set([
  'DataGrid',
  'CodeEditor',
  'Sidebar',
  'Toast',
  'CommandPalette',
  'VirtualList',
]);

const SAFE_NAME_RE = /^[a-zA-Z0-9_]+$/;

function muiEscapeHatch(name) {
  // C3: validate Name before interpolation.
  if (!SAFE_NAME_RE.test(name)) return null;
  return [`from\\s+['"]@mui/material['"]`, `import\\s+\\{[^}]*\\b${name}\\b`];
}

function deriveTriggerContent(name) {
  if (TYPOGRAPHY_NAMES.has(name)) return [TYPOGRAPHY_SENTINEL];
  if (Object.prototype.hasOwnProperty.call(RAW_HTML_TAG, name)) {
    return [RAW_HTML_TAG[name]];
  }
  if (NO_PRIMITIVE_LIST.has(name)) return muiEscapeHatch(name);
  return null;
}

function buildBody(item) {
  const lines = [
    `# ${item.name}`,
    '',
    `**Purpose**: ${item.purpose}`,
    `**Use Cases**: ${item.useCases}`,
    `**Features**: ${item.features}`,
    `**Location**: ${item.location}`,
    `**Docs**: ${item.docsPath}`,
  ];
  return lines.join('\n');
}

function toMemory(item /* , ctx */) {
  if (!item || typeof item.name !== 'string' || !item.name) return null;
  const triggerContent = deriveTriggerContent(item.name);
  if (!triggerContent) return null;
  return {
    name: `ui-component-${item.name}`,
    events: ['PreToolUse'],
    trigger_pretool: ['Edit:.*\\.tsx', 'Write:.*\\.tsx'],
    trigger_pretool_content: triggerContent,
    inject: 'full',
    body: buildBody(item),
  };
}

module.exports = {
  name: 'ui-catalog',
  description: 'Parses packages/ui/components-catalog.md into per-component memories.',
  sources: ['packages/ui/components-catalog.md'],
  parse,
  toMemory,
};
