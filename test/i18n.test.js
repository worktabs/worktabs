const assert = require('node:assert/strict');
const test = require('node:test');
const { TRANSLATIONS, displayLocale, language, listText, messages, resolveLanguage, setLanguage, t, withLanguagePack } = require('../src/i18n');
const { fill, placeholders, translator } = require('../src/i18n/translate');
const fs = require('node:fs');
const path = require('node:path');
const { uiStringsIn, uiStringsInHtml } = require('../scripts/translations');

test('resolveLanguage takes the setting, else the first system language the app has, else English', () => {
  assert.equal(resolveLanguage('ja', ['en-US']), 'ja');
  assert.equal(resolveLanguage('en', ['ja-JP']), 'en');
  // A VS Code language the app's own UI does not have.
  assert.equal(resolveLanguage('de', ['ja-JP']), 'en');
  assert.equal(resolveLanguage('', ['ja-JP', 'en-US']), 'ja');
  assert.equal(resolveLanguage('', ['fr-FR', 'ja']), 'ja');
  assert.equal(resolveLanguage('', ['fr-FR']), 'en');
  assert.equal(resolveLanguage('', []), 'en');
  assert.equal(resolveLanguage('JA_jp'), 'ja');
});

test('translator puts the English text into the table, and fills in the placeholders', () => {
  const tr = translator({ 'Close {name}': '{name} を閉じる' });
  assert.equal(tr('Close {name}', { name: 'a' }), 'a を閉じる');
  // Without a translation: the English, filled in.
  assert.equal(tr('Open {name}', { name: 'a' }), 'Open a');
  assert.equal(translator()('Open'), 'Open');
  // Inherited names are not translations.
  assert.equal(tr('constructor'), 'constructor');
});

test('fill leaves a placeholder without a value as it is', () => {
  assert.equal(fill('{a} and {b}', { a: 1 }), '1 and {b}');
  assert.equal(fill('{a}', { a: 0 }), '0');
  assert.equal(fill('{a}'), '{a}');
});

test('placeholders lists the names once, sorted', () => {
  assert.deepEqual(placeholders('{b} {a} {b}'), ['a', 'b']);
  assert.deepEqual(placeholders('none'), []);
});

test('t follows the language that was set, and an unknown one is English', (ctx) => {
  ctx.after(() => setLanguage('en'));
  assert.equal(language(), 'en');
  assert.equal(t('Cancel'), 'Cancel');
  setLanguage('ja');
  assert.equal(language(), 'ja');
  assert.equal(t('Cancel'), 'キャンセル');
  assert.equal(messages(), TRANSLATIONS.ja);
  setLanguage('xx');
  assert.equal(language(), 'en');
  assert.deepEqual(messages(), {});
});

test('listText joins items as a list in the language', (ctx) => {
  ctx.after(() => setLanguage('en'));
  assert.equal(listText(['a', 'b', 'c']), 'a, b, and c');
  setLanguage('ja');
  assert.equal(listText(['a', 'b', 'c']), 'a、b、c');
});

test('every Japanese translation has the placeholders of its English', () => {
  for (const [english, japanese] of Object.entries(TRANSLATIONS.ja)) {
    assert.deepEqual(placeholders(japanese), placeholders(english), english);
  }
});

test('settings and extension management keep Japanese labels, accessibility text, and import errors', () => {
  const root = path.resolve(__dirname, '..');
  const files = ['src/dialog/index.html', 'src/dialog/settings.js', 'src/dialog/extensions.js',
    'src/code-server/extension-imports.js', 'src/code-server/extension-management.js', 'src/code-server/update-strategies.js', 'src/window/settings-actions.js'];
  const sources = files.flatMap((file) => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    return file.endsWith('.html') ? uiStringsInHtml(source) : uiStringsIn(source);
  });
  sources.push({ text: 'Extensions and updates' });
  // Product names are kept as the source labels; everything else needs a translation.
  const products = new Set(['VS Code', 'Open VSX', 'Worktabs / Open VSX']);
  for (const { text } of sources) {
    assert.ok(Object.hasOwn(TRANSLATIONS.ja, text), text);
    if (!products.has(text)) assert.notEqual(TRANSLATIONS.ja[text], text, text);
  }
});

test('extension validation errors follow the Japanese UI language', (ctx) => {
  ctx.after(() => setLanguage('en'));
  setLanguage('ja');
  const { validateBatch } = require('../src/code-server/extension-imports');
  assert.throws(() => validateBatch([], { target: 'win32-x64' }), { message: '拡張を 1 つ以上選んでください。' });
});

test('displayLocale is the locale setting, else the UI language', () => {
  assert.equal(displayLocale('de', 'en'), 'de');
  assert.equal(displayLocale('zh-CN', 'en'), 'zh-cn');
  assert.equal(displayLocale('', 'ja'), 'ja');
  assert.equal(displayLocale('', 'en'), 'en');
  assert.equal(displayLocale(undefined, undefined), 'en');
});

test('withLanguagePack adds the language pack of the display language, once', () => {
  const claude = ['Anthropic.claude-code'];
  assert.deepEqual(withLanguagePack(claude, 'en'), claude);
  assert.deepEqual(withLanguagePack(claude, 'ja'), [...claude, 'MS-CEINTL.vscode-language-pack-ja']);
  assert.deepEqual(withLanguagePack(claude, 'zh-cn'), [...claude, 'MS-CEINTL.vscode-language-pack-zh-hans']);
  assert.deepEqual(withLanguagePack(claude, 'pt-br'), [...claude, 'MS-CEINTL.vscode-language-pack-pt-BR']);
  // Already configured, in any case.
  const listed = [...claude, 'ms-ceintl.vscode-language-pack-ja'];
  assert.deepEqual(withLanguagePack(listed, 'ja'), listed);
  // A language without a pack.
  assert.deepEqual(withLanguagePack(claude, 'xx'), claude);
  // A copy: the setting is not changed.
  assert.notEqual(withLanguagePack(claude, 'en'), claude);
});
