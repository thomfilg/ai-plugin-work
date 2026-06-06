'use strict';

/**
 * Flat ESLint config consumed by the quality gate.
 *
 * Loaded via `--config` from `quality.js` so its name does not need to match
 * the ESLint default-lookup convention (`eslint.config.js`). Holding the
 * config in this dedicated path keeps it co-located with the rest of the
 * quality runner.
 *
 * Owned dimensions (the spec's six rules):
 *   - complexity (cyclomatic) max 10
 *   - max-depth max 4
 *   - max-lines max 400
 *   - max-lines-per-function max 80
 *
 * Plus a project-specific drift guard:
 *   - no-restricted-syntax → block direct process.env.CLAUDE_PLUGIN_ROOT
 *     reads outside the canonical resolve-plugin-root.js helper, so future
 *     callers cannot accidentally re-introduce the divergent ad-hoc PLUGIN_ROOT
 *     computations that bug #284 stemmed from.
 *
 * The two remaining dimensions live elsewhere:
 *   - cognitive-complexity → Biome (via biome-bridge.js)
 *   - duplicate-blocks     → jscpd (driven from quality.js)
 *
 * Test files are excluded entirely — this matches biome.json
 * (`!**\/__tests__/**`) and the spec.
 */

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      '**/.git/**',
      'tasks/**',
      'external_scripts/**',
      'references/**',
      'docs/**',
      '**/__tests__/**',
      '**/*.test.js',
      '**/*.spec.js',
      // stepScaffold templates contain handlebars-style `{{token}}` placeholders
      // and are not standalone JS until the scaffolder substitutes the tokens.
      'factories/stepScaffold/templates/**',
    ],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
    },
    rules: {
      complexity: ['error', { max: 10 }],
      'max-depth': ['error', { max: 4 }],
      'max-lines': ['error', { max: 400, skipBlankLines: false, skipComments: false }],
      'max-lines-per-function': [
        'error',
        { max: 80, skipBlankLines: false, skipComments: false, IIFEs: true },
      ],
      // Block direct reads of process.env.CLAUDE_PLUGIN_ROOT. Use
      // `resolvePluginRoot()` from `work/lib/resolve-plugin-root.js` instead
      // so every caller agrees on which install layout the plugin lives in
      // (cache / marketplace / dev clone / leaf vs parent plugins-base).
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'MemberExpression[object.object.name="process"][object.property.name="env"][property.name="CLAUDE_PLUGIN_ROOT"]',
          message:
            'Do not read process.env.CLAUDE_PLUGIN_ROOT directly. Use resolvePluginRoot() from plugins/work/scripts/workflows/work/lib/resolve-plugin-root.js so every caller resolves the same install layout.',
        },
      ],
    },
  },
  {
    // The canonical helper IS allowed to read the env var directly; everyone
    // else must go through it.
    files: ['**/scripts/workflows/work/lib/resolve-plugin-root.js'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  // Tighter cap for /work step + gate handlers. The decision matrix in each
  // file is small by design — anything that grows past 120 LOC should be
  // extracted into a sibling `lib/` helper or expressed via a factory in
  // `factories/`. Keeps step bodies declarative rather than free-form.
  {
    files: [
      '**/plugins/work/scripts/workflows/work/steps/*.js',
      '**/plugins/work/scripts/workflows/work/gates/*.js',
    ],
    rules: {
      'max-lines': ['error', { max: 120, skipBlankLines: false, skipComments: false }],
    },
  },
];
