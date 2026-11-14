const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { HELD, OBSOLETE, holdVersions, readEntries, releaseVersions } = require('../src/code-server/obsolete');
const { tempDir } = require('./support');

// An extensions folder as code-server leaves it: a folder per version on disk, the listed ones
// in extensions.json, and `.obsolete`.
function folder(t, { versions = [], listed = [], obsolete } = {}) {
  const dir = tempDir(t);
  for (const [id, version] of versions) fs.mkdirSync(path.join(dir, `${id}-${version}`));
  list(dir, listed);
  if (obsolete) fs.writeFileSync(path.join(dir, OBSOLETE), JSON.stringify(obsolete));
  return dir;
}
const entry = ([id, version]) => ({ identifier: { id }, version, relativeLocation: `${id}-${version}`, metadata: { installedTimestamp: 1 } });
const list = (dir, listed) => fs.writeFileSync(path.join(dir, 'extensions.json'), JSON.stringify(listed.map(entry)));
const read = (dir, name) => (fs.existsSync(path.join(dir, name)) ? JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) : null);
const listed = (dir) => readEntries(dir).map((each) => `${each.identifier.id}@${each.version}`);

test('holding lists the replaced versions again beside the new ones and takes them out of .obsolete', (t) => {
  const dir = folder(t, { versions: [['openai.chatgpt', '1.0.0'], ['openai.chatgpt', '2.0.0'], ['openai.codex-audio', '1.0.0'], ['openai.codex-audio', '2.0.0'], ['acme.other', '1.0.0']],
    listed: [['openai.chatgpt', '1.0.0'], ['openai.codex-audio', '1.0.0'], ['acme.other', '1.0.0']] });
  const before = readEntries(dir).filter((each) => each.identifier.id.startsWith('openai.'));
  // What installing the new versions leaves.
  list(dir, [['openai.chatgpt', '2.0.0'], ['openai.codex-audio', '2.0.0'], ['acme.other', '1.0.0']]);
  fs.writeFileSync(path.join(dir, OBSOLETE), JSON.stringify({ 'openai.chatgpt-1.0.0-win32-x64': true, 'openai.codex-audio-1.0.0': true, 'openai.chatgpt-1.0.00': true }));
  const held = holdVersions(dir, before);
  assert.deepEqual(held, [
    { id: 'openai.chatgpt', version: '1.0.0', keys: ['openai.chatgpt-1.0.0-win32-x64'] },
    { id: 'openai.codex-audio', version: '1.0.0', keys: ['openai.codex-audio-1.0.0'] },
  ]);
  assert.deepEqual(listed(dir), ['openai.chatgpt@2.0.0', 'openai.codex-audio@2.0.0', 'acme.other@1.0.0', 'openai.chatgpt@1.0.0', 'openai.codex-audio@1.0.0']);
  assert.deepEqual(readEntries(dir).at(-1), before[1]);
  assert.deepEqual(read(dir, OBSOLETE), { 'openai.chatgpt-1.0.00': true });
  assert.deepEqual(read(dir, HELD), held);
});

test('only a version older than the one now listed is held, and only while its folder is there', (t) => {
  const dir = folder(t, { versions: [['a.b', '2.0.0'], ['c.d', '1.0.0'], ['e.f', '1.0.0']], listed: [['a.b', '2.0.0'], ['c.d', '1.0.0'], ['e.f', '1.0.0'], ['g.h', '1.0.0']] });
  const before = readEntries(dir);
  // a.b went back to 1.0.0, c.d was not replaced, e.f's folder is gone, g.h was removed.
  list(dir, [['a.b', '1.0.0'], ['c.d', '1.0.0'], ['e.f', '2.0.0']]);
  fs.rmSync(path.join(dir, 'e.f-1.0.0'), { recursive: true });
  assert.deepEqual(holdVersions(dir, before), []);
  assert.deepEqual(listed(dir), ['a.b@1.0.0', 'c.d@1.0.0', 'e.f@2.0.0']);
  assert.equal(read(dir, HELD), null);
});

test('releasing takes the held versions off the list and marks them obsolete again', (t) => {
  const dir = folder(t, { versions: [['a.b', '1.0.0'], ['a.b', '2.0.0'], ['c.d', '1.0.0'], ['c.d', '2.0.0']], listed: [['a.b', '1.0.0'], ['c.d', '1.0.0']] });
  const before = readEntries(dir);
  list(dir, [['a.b', '2.0.0'], ['c.d', '2.0.0']]);
  fs.writeFileSync(path.join(dir, OBSOLETE), JSON.stringify({ 'a.b-1.0.0': true, 'c.d-1.0.0-universal': true, 'x.y-1.0.0': true }));
  const first = holdVersions(dir, [before[0]]);
  holdVersions(dir, [before[1]]);
  releaseVersions(dir, first);
  assert.deepEqual(listed(dir), ['a.b@2.0.0', 'c.d@2.0.0', 'c.d@1.0.0']);
  assert.deepEqual(read(dir, OBSOLETE), { 'x.y-1.0.0': true, 'a.b-1.0.0': true });
  assert.deepEqual(read(dir, HELD).map((each) => each.id), ['c.d']);
  // At start, everything an earlier run held goes.
  releaseVersions(dir);
  assert.deepEqual(listed(dir), ['a.b@2.0.0', 'c.d@2.0.0']);
  assert.deepEqual(read(dir, OBSOLETE), { 'x.y-1.0.0': true, 'a.b-1.0.0': true, 'c.d-1.0.0-universal': true });
  assert.equal(read(dir, HELD), null);
});

test('a held version that is the only one listed again (the update went back to it) stays, unmarked', (t) => {
  const dir = folder(t, { versions: [['a.b', '1.0.0'], ['a.b', '2.0.0']], listed: [['a.b', '1.0.0']] });
  const before = readEntries(dir);
  list(dir, [['a.b', '2.0.0']]);
  fs.writeFileSync(path.join(dir, OBSOLETE), JSON.stringify({ 'a.b-1.0.0': true }));
  holdVersions(dir, before);
  assert.equal(read(dir, OBSOLETE), null);
  // Going back to 1.0.0 lists it alone, and marks 2.0.0.
  list(dir, [['a.b', '1.0.0']]);
  fs.writeFileSync(path.join(dir, OBSOLETE), JSON.stringify({ 'a.b-2.0.0': true }));
  releaseVersions(dir);
  assert.deepEqual(listed(dir), ['a.b@1.0.0']);
  assert.deepEqual(read(dir, OBSOLETE), { 'a.b-2.0.0': true });
  assert.equal(read(dir, HELD), null);
  assert.deepEqual(releaseVersions(dir), []);
});
