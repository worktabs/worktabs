const js = require('@eslint/js');
const globals = require('globals');

// The sidebar and dialog pages load their files as plain <script> tags (index.html), so each
// file sees what the files before it declared at the top level.
const PAGE_SHARED = ['t', 'translator'];
const SIDEBAR_SHARED = [
  'sidebarModel', 'SidebarData', 'elapsedText', 'sinceText', 'listText', 'recentChecks', 'ownChecks',
  'checkLabel', 'checksLines', 'pressHold', 'hoverIntent', 'createSidebarRows', 'createGithubBar',
  'createUpdateCard', 'createAppUpdateCard', 'createUsageFooter', 'attachSidebarResize', 'createPageTheme', 'createIcons',
  'createPullSelectors', 'createUnclonedSection',
];
const DIALOG_SHARED = [
  'answer', 'dialogKey', 'formKey', 'addFormKey', 'cloneFormKey', 'settingsFormKey', 'settingsDialog',
  'readAgentChoices', 'showAddForm', 'hideAddForm', 'showCloneForm', 'hideCloneForm',
  'showSettingsForm', 'hideSettingsForm', 'showExtensionManager', 'hideExtensionManager',
];
const readonly = (names) => Object.fromEntries(names.map((name) => [name, 'readonly']));

module.exports = [
  { ignores: ['node_modules/', 'dist/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      // A leading underscore marks a name kept on purpose (a skipped argument or destructured part).
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Best-effort cleanups (removing a temporary file, killing a process) ignore their errors.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Control characters are matched on purpose: terminal output and XML text are cleaned of them.
      'no-control-regex': 'off',
    },
  },
  {
    files: ['src/sidebar/**/*.js', 'src/dialog/**/*.js', 'src/i18n/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, ...globals.node, ...readonly(PAGE_SHARED) } },
    // A file that declares one of the shared names is where it comes from, not a redeclaration.
    rules: {
      'no-redeclare': ['error', { builtinGlobals: false }],
      // What a file declares at the top level is used by the files after it.
      'no-unused-vars': ['error', { vars: 'local', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  { files: ['src/sidebar/**/*.js'], languageOptions: { globals: readonly(SIDEBAR_SHARED) } },
  // settings.js opens and closes the settings dialog that dialog.js keeps.
  { files: ['src/dialog/**/*.js'], languageOptions: { globals: { ...readonly(DIALOG_SHARED), settingsDialog: 'writable' } } },
];
