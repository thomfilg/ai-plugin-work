'use strict';

/**
 * render.js — generate .envrc / .env content from schemas + answers.
 *
 * The .envrc layout mirrors the field-proven worktree wrapper convention:
 *   Git / GitHub  → account-pinned GH_TOKEN block + git identity exports
 *   per-plugin sections → one header per schema section, set vars exported,
 *   unset vars emitted as commented defaults so the file self-documents.
 */

const HEADER_WIDTH = 65;

function sectionHeader(title) {
  const label = `# ─── ${title} `;
  return label + '─'.repeat(Math.max(3, HEADER_WIDTH - label.length));
}

/**
 * Account-pinned GH_TOKEN block. Fails loudly: an expired login never
 * exports an empty GH_TOKEN (that silently breaks auth) — it unsets it and
 * surfaces a direnv warning instead.
 */
function renderGhTokenBlock(ghUser) {
  return [
    '# Pin gh + git ops to the ' + ghUser + ' account. Fail LOUDLY: if `gh auth token`',
    '# returns empty (token expired / logged out), do NOT export an empty GH_TOKEN —',
    '# that silently breaks auth. Unset it so gh falls back to stored creds',
    '# (hosts.yml) and surface the degradation via a visible warning.',
    '# log_status is the direnv stdlib logger; shim it when the file is sourced directly.',
    'command -v log_status >/dev/null 2>&1 || log_status() { echo "$*" >&2; }',
    `_gh_token=$(gh auth token -u ${ghUser} 2>/dev/null)`,
    'if [ -n "$_gh_token" ]; then',
    '  export GH_TOKEN="$_gh_token"',
    'else',
    '  unset GH_TOKEN',
    `  log_status "⚠ GH_TOKEN unset: 'gh auth token -u ${ghUser}' failed — run 'gh auth login -u ${ghUser}' (gh is using stored creds for now)"`,
    'fi',
    'unset _gh_token',
  ].join('\n');
}

/**
 * Git identity exports. mode "default" defers to `git config` at direnv
 * time; mode "custom" pins literal name/email.
 */
function renderGitIdentityBlock(identity = { mode: 'default' }) {
  if (identity.mode === 'custom') {
    const name = dquoteEscape(identity.name);
    const email = dquoteEscape(identity.email);
    return [
      `export GIT_AUTHOR_NAME="${name}"`,
      `export GIT_COMMITTER_NAME="${name}"`,
      `export GIT_AUTHOR_EMAIL="${email}"`,
      `export GIT_COMMITTER_EMAIL="${email}"`,
    ].join('\n');
  }
  return [
    'export GIT_AUTHOR_NAME="$(git config user.name)"',
    'export GIT_COMMITTER_NAME="$(git config user.name)"',
    'export GIT_AUTHOR_EMAIL="$(git config user.email)"',
    'export GIT_COMMITTER_EMAIL="$(git config user.email)"',
  ].join('\n');
}

function needsQuoting(value) {
  return /[\s"'`$#\\]/.test(value);
}

function dquoteEscape(value) {
  return String(value).replace(/[\\"]/g, '\\$&');
}

/**
 * Quote a value for a shell assignment. Default is double-quoting so
 * `$HOME`-style references still expand at source time; `literal: true`
 * (command-type vars) single-quotes so expansion is deferred to run time.
 */
function quoteEnvValue(value, { literal = false } = {}) {
  const str = String(value);
  if (!needsQuoting(str)) return str;
  if (literal) return `'${str.replace(/'/g, "'\\''")}'`;
  return `"${dquoteEscape(str)}"`;
}

function renderVarLine(name, def, value) {
  if (value !== undefined && value !== null && value !== '') {
    return `export ${name}=${quoteEnvValue(value, { literal: def.type === 'command' })}`;
  }
  const hint = def.example || def.default || '';
  return `# export ${name}=${hint}`;
}

function groupVarsBySection(schema) {
  const sections = new Map();
  for (const [name, def] of Object.entries(schema.vars)) {
    const key = `${def.section}${def.advanced ? ' (advanced)' : ''}`;
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key).push([name, def]);
  }
  return sections;
}

function renderSectionLines(vars, values, isAdvanced) {
  const lines = [];
  for (const [name, def] of vars) {
    const value = values[name];
    if (isAdvanced && (value === undefined || value === '')) continue;
    lines.push(`# ${def.description}`, renderVarLine(name, def, value));
  }
  return lines;
}

/**
 * Render one plugin's sections. Unset advanced vars are skipped entirely
 * unless another var in their section is set — the file stays readable.
 */
function renderPluginSections(schema, values) {
  const chunks = [];
  for (const [section, vars] of groupVarsBySection(schema)) {
    const isAdvanced = section.endsWith('(advanced)');
    const lines = renderSectionLines(vars, values, isAdvanced);
    const hasExports = lines.some((line) => !line.startsWith('#'));
    if (hasExports || !isAdvanced) {
      chunks.push([sectionHeader(`${schema.plugin}: ${section}`), ...lines].join('\n'));
    }
  }
  return chunks;
}

/**
 * Render the complete .envrc.
 * @param {object} opts
 * @param {string} opts.ghUser          gh account to pin GH_TOKEN to
 * @param {object} opts.gitIdentity     { mode: 'default' } | { mode: 'custom', name, email }
 * @param {object[]} opts.schemas       plugin schemas, render order preserved
 * @param {object} opts.values          { VAR: value } chosen by the user
 */
function renderEnvrc({ ghUser, gitIdentity, schemas, values }) {
  const parts = [
    sectionHeader('Git / GitHub'),
    renderGhTokenBlock(ghUser),
    renderGitIdentityBlock(gitIdentity),
  ];
  for (const schema of schemas) {
    parts.push(...renderPluginSections(schema, values));
  }
  return `${parts.join('\n\n')}\n`;
}

/**
 * Merge KEY=value pairs into existing .env/.envrc content: in-place update
 * for keys already present (commented or not), append the rest. With
 * exportPrefix (the .envrc form) lines are written as `export KEY=value`.
 */
function mergeEnvContent(existing, updates, { exportPrefix = false } = {}) {
  const prefix = exportPrefix ? 'export ' : '';
  const lines = String(existing || '').split('\n');
  const pending = { ...updates };
  const merged = lines.map((line) => {
    const match = line.match(/^(?:#\s*)?(?:export\s+)?([A-Z][A-Z0-9_]*)=/);
    if (match && match[1] in pending) {
      const value = pending[match[1]];
      delete pending[match[1]];
      return `${prefix}${match[1]}=${quoteEnvValue(value)}`;
    }
    return line;
  });
  while (merged.length && merged[merged.length - 1] === '') merged.pop();
  for (const [name, value] of Object.entries(pending)) {
    merged.push(`${prefix}${name}=${quoteEnvValue(value)}`);
  }
  return `${merged.join('\n')}\n`;
}

module.exports = {
  sectionHeader,
  renderGhTokenBlock,
  renderGitIdentityBlock,
  quoteEnvValue,
  renderVarLine,
  renderPluginSections,
  renderEnvrc,
  mergeEnvContent,
};
