import globals from 'globals';

export default [
  { ignores: ['**/node_modules/**', '**/web/admin-qr.js'] },
  {
    files: ['camera/**/*.js', 'camera/**/*.mjs', 'tests/**/*.mjs'],
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-dupe-keys': 'error',
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-unused-vars': ['error', { caughtErrors: 'none' }],
      'no-unsafe-finally': 'error',
    },
  },
  {
    files: ['camera/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['camera/camera.js'],
    languageOptions: { sourceType: 'script' },
  },
  {
    files: ['camera/**/*.mjs', 'tests/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
];
