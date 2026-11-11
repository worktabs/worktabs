const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOpenVsx } = require('../src/code-server/open-vsx');

const API = 'https://open-vsx.org/api';

// An Open VSX entry, as the query and version endpoints answer it.
function entry(version, { preRelease = false, platform = 'win32-x64', engine = '^1.96.2', bundled = [], namespace = 'openai', name = 'chatgpt' } = {}) {
  const file = `${namespace}.${name}-${version}@${platform}`;
  return { namespace, name, displayName: 'Codex', version, preRelease, targetPlatform: platform, engines: { vscode: engine },
    bundledExtensions: bundled.map((id) => ({ namespace: id.split('.')[0], extension: id.split('.')[1] })),
    files: { download: `https://cdn.example/${file}.vsix`, sha256: `https://cdn.example/${file}.sha256` } };
}

// A fetch that answers the URLs in `routes` (a value, or a function of nothing) and 404 otherwise.
function fakeFetch(routes) {
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    if (!(url in routes)) return new Response(JSON.stringify({ error: 'Extension not found' }), { status: 404 });
    const value = typeof routes[url] === 'function' ? routes[url]() : routes[url];
    return value instanceof Response ? value : new Response(JSON.stringify(value), { status: 200 });
  };
  return { fetch, asked };
}

const query = (id, platform) => `${API}/-/query?extensionId=${id}&targetPlatform=${platform}`;

test('the newest release is taken over newer-numbered pre-releases and versions that need a newer VS Code', async () => {
  const { fetch, asked } = fakeFetch({
    [query('openai.chatgpt', 'win32-x64')]: { extensions: [entry('26.51106.51428', { preRelease: true })] },
    [`${query('openai.chatgpt', 'win32-x64')}&includeAllVersions=true`]: { extensions: [
      entry('26.51106.51428', { preRelease: true }), entry('26.1200.1', { engine: '^1.200.0' }),
      entry('26.1021.22027'), entry('26.1106.51428', { bundled: ['openai.codex-audio'] }), entry('26.5908.1', { preRelease: true }),
    ] },
  });
  const release = await createOpenVsx({ fetch }).latestRelease('openai.chatgpt', 'win32-x64', '1.145.2');
  assert.equal(release.version, '26.1106.51428');
  assert.equal(release.id, 'openai.chatgpt');
  assert.deepEqual(release.bundled, ['openai.codex-audio']);
  assert.equal(release.page, 'https://open-vsx.org/extension/openai/chatgpt');
  assert.equal(asked.length, 2);
});

test('the latest version is used without the full list when it is a usable release', async () => {
  const { fetch, asked } = fakeFetch({ [query('anthropic.claude-code', 'linux-x64')]: { extensions: [entry('2.1.322', { namespace: 'anthropic', name: 'claude-code', platform: 'linux-x64' })] } });
  assert.equal((await createOpenVsx({ fetch }).latestRelease('anthropic.claude-code', 'linux-x64', '1.145.2')).version, '2.1.322');
  assert.equal(asked.length, 1);
});

test('an extension published once for every platform is found as universal', async () => {
  const { fetch } = fakeFetch({ [query('openai.codex-audio', 'universal')]: { extensions: [entry('26.1106.51428', { platform: 'universal', name: 'codex-audio' })] } });
  const release = await createOpenVsx({ fetch }).latestRelease('openai.codex-audio', 'darwin-arm64', '1.145.2');
  assert.equal(release.targetPlatform, 'universal');
  assert.equal(await createOpenVsx({ fetch: fakeFetch({}).fetch }).latestRelease('acme.missing', 'win32-x64', '1.145.2'), null);
});

test('a pack member is taken at the pack version for the platform, else universal, and never as a pre-release', async () => {
  const { fetch } = fakeFetch({
    [`${API}/openai/codex-audio/universal/26.1021.22027`]: entry('26.1021.22027', { platform: 'universal', name: 'codex-audio' }),
    [`${API}/openai/codex-audio/universal/26.51106.51428`]: entry('26.51106.51428', { platform: 'universal', name: 'codex-audio', preRelease: true }),
  });
  const openVsx = createOpenVsx({ fetch });
  assert.equal((await openVsx.releaseOf('openai.codex-audio', '26.1021.22027', 'win32-x64')).version, '26.1021.22027');
  assert.equal(await openVsx.releaseOf('openai.codex-audio', '26.51106.51428', 'win32-x64'), null);
  assert.equal(await openVsx.releaseOf('openai.codex-audio', '1.0.0', 'win32-x64'), null);
});

test('a download is kept only when it matches the published SHA-256, and reports its progress', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worktabs-openvsx-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = Buffer.from('a complete VSIX payload');
  const sum = crypto.createHash('sha256').update(payload).digest('hex');
  const release = { ...entry('26.1106.51428'), name: 'Codex', version: '26.1106.51428', download: 'https://cdn.example/codex.vsix', sha256: 'https://cdn.example/codex.sha256' };
  const progress = [];
  const good = fakeFetch({
    [release.sha256]: () => new Response(`${sum}  codex.vsix\n`),
    [release.download]: () => new Response(payload, { headers: { 'content-length': String(payload.length) } }),
  });
  const file = path.join(root, 'codex.vsix');
  await createOpenVsx({ fetch: good.fetch }).download(release, file, { onProgress: (mb, total) => progress.push([mb, total]) });
  assert.deepEqual(fs.readFileSync(file), payload);
  assert.ok(progress.length >= 1);
  assert.equal(fs.existsSync(`${file}.part`), false);

  const broken = fakeFetch({
    [release.sha256]: () => new Response(`${'0'.repeat(64)}\n`),
    [release.download]: () => new Response(payload),
  });
  const other = path.join(root, 'broken.vsix');
  await assert.rejects(createOpenVsx({ fetch: broken.fetch }).download(release, other), /does not match its checksum/);
  assert.deepEqual(fs.readdirSync(root), ['codex.vsix']);

  const noSum = fakeFetch({ [release.sha256]: () => new Response('not found'), [release.download]: () => new Response(payload) });
  await assert.rejects(createOpenVsx({ fetch: noSum.fetch }).download(release, other), /no checksum/);
  const gone = fakeFetch({ [release.sha256]: () => new Response(sum), [release.download]: () => new Response('', { status: 503 }) });
  await assert.rejects(createOpenVsx({ fetch: gone.fetch }).download(release, other), /HTTP 503/);
  assert.deepEqual(fs.readdirSync(root), ['codex.vsix']);
});
