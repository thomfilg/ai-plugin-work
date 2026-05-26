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
    },
  },
];
