const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { RepositoryService } = require('../src/repos/repository-service');
const { repoCatalog } = require('../src/repos/worktrees');

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const folder = (name) => path.resolve('test-repos', name);
const repo = (name) => ({ path: folder(name), git: true, sources: ['config'] });
const remote = (url) => ({ provider: 'github', url, visibility: 'private', current: null });

function setup(saved = null, overrides = {}) {
  const messages = [], writes = [], logs = [];
  const config = { unclonedRepos: false, repoSources: [], repos: [], hiddenGithubOwners: [] };
  const deps = {
    config: () => config, tabs: () => new Map(),
    catalog: async () => ({ repos: [], ghq: [], problems: [] }),
    remotes: async () => new Map(), visibility: async () => new Map(),
    hosts: async () => ['github.com'], owned: async () => [], pulls: async () => [],
    running: async () => new Set(), now: () => 1234,
    write: (cache) => writes.push(JSON.parse(JSON.stringify(cache))), log: (line) => logs.push(line),
    changed: () => messages.push(service.message()), ...overrides,
  };
  const service = new RepositoryService(deps, saved);
  return { service, deps, messages, writes, logs, config };
}
const cache = (repos, remotes = {}) => ({ repos, remotes, worktrees: {}, owned: [] });

test('catalog refreshes coalesce and explicit requests during a read schedule one follow-up', async () => {
  const first = deferred(), second = deferred();
  let reads = 0;
  const { service, messages } = setup(null, { catalog: () => ++reads === 1 ? first.promise : second.promise });
  const pending = service.refresh();
  assert.equal(service.refresh(), pending);
  assert.equal(service.refresh({ again: true }), pending);
  assert.equal(service.refresh({ again: true }), pending);
  assert.equal(reads, 1);
  first.resolve({ repos: [repo('a')], problems: [], ghq: [] });
  await pending;
  assert.equal(reads, 2);
  second.resolve({ repos: [repo('b')], problems: [], ghq: [] });
  await service.catalogRead;
  await flush();
  assert.deepEqual(service.list, [repo('b')]);
  assert.ok(messages.some((message) => message.reading));
  assert.ok(messages.every((message, i) => !i || message.seq > messages[i - 1].seq));
});

test('a clone added during an older catalog read appears immediately and survives that reply', async () => {
  const first = deferred(), second = deferred();
  let reads = 0;
  const { service, messages } = setup(null, { catalog: () => ++reads === 1 ? first.promise : second.promise });
  const pending = service.refresh();
  service.add(folder('clone'), 'config', remote('https://github.com/me/clone'));
  assert.ok(messages.at(-1).repos.some((repo) => repo.path === folder('clone')));
  first.resolve({ repos: [], problems: [], ghq: [] });
  await pending;
  assert.ok(service.list.some((repo) => repo.path === folder('clone')));
  assert.equal(service.remotes.get(folder('clone').toLowerCase()).provider, 'github');
  second.resolve({ repos: service.list, problems: [], ghq: [] });
  await service.catalogRead;
});

test('failed catalog sources retain prior entries; a successful empty read clears and prunes them', async () => {
  const saved = cache([{ path: folder('a'), git: true, sources: ['ghq'] }], { [folder('a').toLowerCase()]: remote('https://github.com/me/a') });
  saved.worktrees[folder('a').toLowerCase()] = [{ path: folder('a') }];
  let fails = true;
  const { service, config } = setup(saved, { catalog: (settings, previous) => repoCatalog(settings, previous, {
    ghq: async () => { if (fails) throw new Error('offline'); return { ghq: true, repos: [] }; },
  }) });
  config.repoSources = ['ghq'];
  await service.refresh();
  assert.equal(service.list.length, 1);
  fails = false;
  await service.refresh();
  await flush();
  assert.deepEqual(service.list, []);
  assert.equal(service.remotes.size, 0);
  assert.equal(service.worktrees.size, 0);
});

test('cache writes deduplicate and preserve worktrees read in this run outside the listed catalog', () => {
  const { service, writes } = setup(cache([repo('a')]));
  service.remember(folder('other'), []);
  assert.equal(writes.length, 1);
  service.save();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].worktrees[folder('other').toLowerCase()], []);
});

test('a global catalog failure retains the startup cache and reports the problem', async () => {
  const { service, logs } = setup(cache([repo('a')]), { catalog: async () => { throw new Error('offline'); } });
  await service.refresh();
  assert.deepEqual(service.list, [repo('a')]);
  assert.ok(logs.some((line) => line.includes('offline')));
});

test('renamed remote addresses match owned repositories and approved pulls', async () => {
  const url = 'https://github.com/me/old', current = 'https://github.com/me/new';
  const { service, config } = setup(cache([repo('a')], { [folder('a').toLowerCase()]: remote(url) }), {
    visibility: async () => new Map([[url, { visibility: 'private', current }]]),
    owned: async () => [{ host: 'github.com', owner: 'me', name: 'new', url: current }],
    pulls: async () => [{ repo: current, number: 7, title: 'Ready', url: `${current}/pull/7` }],
  });
  config.unclonedRepos = true;
  await service.refreshVisibility();
  await service.approvedRead;
  assert.equal(service.remotes.get(folder('a').toLowerCase()).current, current);
  assert.deepEqual(service.uncloned(), []);
  assert.equal(service.approved.get(folder('a').toLowerCase())[0].number, 7);
});

test('the side bar hears whose each repository is on its remote\'s host, and which owners are the accounts\'', async () => {
  const key = (name) => folder(name).toLowerCase();
  const saved = cache([repo('moved'), repo('cloned'), repo('lab'), repo('old-lab'), repo('elsewhere'), repo('none'), repo('unread')], {
    // GitHub has it under another owner now.
    [key('moved')]: { ...remote('https://github.com/old/moved'), owner: { host: 'github.com', owner: 'old' }, current: 'https://github.com/New/moved' },
    // Put in the list by a clone, or kept by a version before: the owner is in its address.
    [key('cloned')]: remote('https://github.example.com:8443/team/cloned'),
    [key('lab')]: { provider: 'gitlab', url: null, owner: { host: 'gitlab.com', owner: 'group/sub' }, visibility: null, current: null },
    // Kept without its owner by a version before: read once more.
    [key('old-lab')]: { provider: 'gitlab', url: null, visibility: null, current: null },
    [key('elsewhere')]: { provider: 'other', url: null, owner: null, visibility: null, current: null },
    [key('none')]: { provider: 'none', url: null, owner: null, visibility: null, current: null },
  });
  saved.owned = [
    { host: 'github.com', owner: 'Me', type: 'user', name: 'a', url: 'https://github.com/Me/a' },
    { host: 'github.com', owner: 'org', type: 'org', name: 'b', url: 'https://github.com/org/b' },
  ];
  const asked = [];
  const { service, config } = setup(saved, {
    remotes: async (folders) => {
      asked.push(...folders);
      return new Map([
        [folder('old-lab'), { provider: 'gitlab', url: null, owner: { host: 'gitlab.com', owner: 'g' } }],
        [folder('unread'), { provider: 'bitbucket', url: null, owner: { host: 'bitbucket.org', owner: 'team' } }],
      ]);
    },
    owned: async () => saved.owned,
  });
  config.unclonedRepos = true;
  const before = service.message();
  assert.deepEqual(before.owners, {
    [key('moved')]: { host: 'github.com', owner: 'New' },
    [key('cloned')]: { host: 'github.example.com', owner: 'team' },
    [key('lab')]: { host: 'gitlab.com', owner: 'group/sub' },
  });
  assert.deepEqual(before.ownerTypes, { 'github.com/me': 'user', 'github.com/org': 'org' });
  await service.refreshVisibility();
  assert.deepEqual(asked, [folder('old-lab'), folder('unread')]);
  const after = service.message().owners;
  assert.deepEqual(after[key('old-lab')], { host: 'gitlab.com', owner: 'g' });
  assert.deepEqual(after[key('unread')], { host: 'bitbucket.org', owner: 'team' });
  assert.deepEqual(service.remotes.get(key('unread')), { provider: 'bitbucket', url: null, owner: { host: 'bitbucket.org', owner: 'team' }, visibility: null, current: null });
});

test('visibility replies cannot restore removed repositories or replace a newer remote', async () => {
  const read = deferred();
  const key = folder('a').toLowerCase();
  const { service } = setup(cache([repo('a')], { [key]: remote('https://github.com/me/old') }), { remotes: () => read.promise });
  service.invalidateRemotes();
  const pending = service.refreshVisibility();
  service.add(folder('a'), 'config', remote('https://github.com/me/new'));
  read.resolve(new Map([[folder('a'), remote('https://github.com/me/old')]]));
  await pending;
  assert.equal(service.remotes.get(key).url, 'https://github.com/me/new');
  service.list = [];
  service.save();
  await service.refreshVisibility();
  assert.equal(service.remotes.size, 0);
});

test('approval follow-up requests combine the all flag and periodic reads do not wake WSL', async () => {
  const first = deferred();
  const local = repo('a'), wsl = { path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', git: true };
  let reads = 0;
  const places = [];
  const saved = cache([local, wsl], {
    [local.path.toLowerCase()]: remote('https://github.com/me/a'),
    [wsl.path.toLowerCase()]: remote('https://github.com/me/wsl'),
  });
  const { service } = setup(saved, { pulls: async (_host, { folder }) => {
    places.push(folder);
    return ++reads === 1 ? first.promise : [];
  } });
  const pending = service.refreshApproved();
  await flush();
  service.refreshApproved(true);
  service.refreshApproved(false);
  assert.equal(service.approvedAgain.all, true);
  first.resolve([]);
  await pending;
  await service.approvedRead;
  assert.deepEqual(places, [local.path, local.path, wsl.path]);
  assert.equal(service.approvedAt, 1234);
});

test('failed approval reads keep prior marks and successful empty reads clear them', async () => {
  const key = folder('a').toLowerCase();
  const { service, deps } = setup(cache([repo('a')], { [key]: remote('https://github.com/me/a') }), {
    pulls: async () => { throw new Error('offline'); },
  });
  service.approved.set(key, [{ number: 7 }]);
  await service.refreshApproved();
  assert.equal(service.approved.get(key)[0].number, 7);
  deps.pulls = async () => [];
  await service.refreshApproved();
  assert.equal(service.approved.size, 0);
});

test('failed owned hosts keep their cache and signed-out hosts are removed', async () => {
  const saved = cache([]);
  saved.owned = [{ host: 'github.com', owner: 'me', name: 'a', url: 'https://github.com/me/a' }];
  const { service, config, deps } = setup(saved, { owned: async () => { throw new Error('offline'); } });
  config.unclonedRepos = true;
  await service.refreshVisibility();
  assert.equal(service.owned.length, 1);
  deps.hosts = async () => [];
  await service.refreshVisibility();
  assert.equal(service.owned.length, 0);
});

test('visibility asks each host at once, and a host that fails leaves the others answered', async () => {
  const urls = { a: 'https://github.com/me/a', b: 'https://ghe.example.com/me/b', c: 'https://gitlab-like.example.org/me/c' };
  const asked = new Map();
  const { service, logs } = setup(cache([repo('a'), repo('b'), repo('c')], Object.fromEntries(
    Object.entries(urls).map(([name, url]) => [folder(name).toLowerCase(), { ...remote(url), visibility: null }]),
  )), {
    visibility: (list) => {
      const reply = deferred();
      asked.set(new URL(list[0]).host, reply);
      return reply.promise;
    },
  });
  const pending = service.refreshVisibility();
  for (let i = 0; i < 5 && asked.size < 3; i++) await flush();
  // All three hosts are asked before any answers.
  assert.deepEqual([...asked.keys()].sort(), ['ghe.example.com', 'github.com', 'gitlab-like.example.org']);
  asked.get('ghe.example.com').resolve(new Map([[urls.b, { visibility: 'internal', current: null }]]));
  asked.get('github.com').resolve(new Map([[urls.a, { visibility: 'public', current: null }]]));
  asked.get('gitlab-like.example.org').resolve(Promise.reject(new Error('offline')));
  await pending;
  const visibility = (name) => service.remotes.get(folder(name).toLowerCase()).visibility;
  assert.equal(visibility('a'), 'public');
  assert.equal(visibility('b'), 'internal');
  assert.equal(visibility('c'), null);
  assert.ok(logs.some((line) => line.includes('offline')));
});

test('visibility refreshes serialize and coalesce requests made during an earlier read', async () => {
  const first = deferred();
  let reads = 0;
  const { service } = setup(cache([]), { remotes: () => ++reads === 1 ? first.promise : Promise.resolve(new Map()) });
  const pending = service.refreshVisibility();
  assert.equal(service.refreshVisibility(), pending);
  assert.equal(service.refreshVisibility(), pending);
  first.resolve(new Map());
  await pending;
  await service.visibilityRead;
  assert.equal(reads, 2);
});

test('failed WSL source reads keep clone destinations; successful reads replace them', async () => {
  const { service, deps } = setup(cache([]), { catalog: async () => ({ repos: [], ghq: [], problems: [{ source: 'wsl:Ubuntu', message: 'offline' }] }) });
  service.ghqDistros.set('ubuntu', 'Ubuntu');
  service.ghqDistros.set('debian', 'Debian');
  await service.refresh();
  assert.deepEqual([...service.ghqDistros.values()], ['Ubuntu']);
  deps.catalog = async () => ({ repos: [], ghq: ['wsl:Debian'], problems: [] });
  await service.refresh();
  assert.deepEqual([...service.ghqDistros.values()], ['Debian']);
});
