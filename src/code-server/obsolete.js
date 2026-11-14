// Keeping a replaced extension version on disk while a tab still runs it (#62). Installing a
// version takes the one it replaces out of the extensions folder's `extensions.json` and names it
// in `.obsolete`. Each code-server that starts then names every folder that no `extensions.json`
// lists in `.obsolete` too, and deletes what `.obsolete` names. So an update that leaves busy tabs
// running on the old version lists it in `extensions.json` again, beside the new one, and takes
// it out of `.obsolete`. code-server runs the newest version listed, so only an older version can
// stay listed. What is held is written to a file of its own, so that a run that ends before the
// tabs restart still lets it go at the next start.
const fs = require('fs');
const path = require('path');
const semver = require('semver');
const { validRelativeLocation } = require('./extension-index');

const INDEX = 'extensions.json';
const OBSOLETE = '.obsolete';
// VS Code leaves the names that start with a dot alone in the extensions folder.
const HELD = '.worktabs-held.json';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeJson(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
}

// The entries of `extensions.json` as code-server wrote them, to be written back unchanged.
function readEntries(dir) {
  const value = readJson(path.join(dir, INDEX), []);
  if (!Array.isArray(value)) throw new Error('Invalid extension list.');
  return value;
}

const idOf = (entry) => (typeof entry?.identifier?.id === 'string' ? entry.identifier.id.toLowerCase() : null);

function readObsolete(dir) {
  const value = readJson(path.join(dir, OBSOLETE), {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// As code-server leaves it: the file goes once nothing is in it.
function writeObsolete(dir, obsolete) {
  if (Object.keys(obsolete).length) writeJson(path.join(dir, OBSOLETE), obsolete);
  else fs.rmSync(path.join(dir, OBSOLETE), { force: true });
}

function readHeld(dir) {
  const value = readJson(path.join(dir, HELD), []);
  return Array.isArray(value) ? value.filter((entry) => typeof entry?.id === 'string' && typeof entry.version === 'string' && Array.isArray(entry.keys)) : [];
}

function writeHeld(dir, held) {
  if (held.length) writeJson(path.join(dir, HELD), held);
  else fs.rmSync(path.join(dir, HELD), { force: true });
}

// A key is `<id>-<version>`, with `-<target platform>` after it unless that is undefined.
function keyOf(key, id, version) {
  const base = `${id}-${version}`.toLowerCase();
  const lower = key.toLowerCase();
  return lower === base || lower.startsWith(`${base}-`);
}

// Lists the `before` entries (read before an install) again that the install replaced with a
// newer version, and takes them out of `.obsolete`. Returns what is held: [{ id, version, keys }].
function holdVersions(dir, before) {
  const entries = readEntries(dir);
  const obsolete = readObsolete(dir);
  const held = [];
  for (const old of before) {
    const id = idOf(old);
    if (!id || !semver.valid(old.version) || !validRelativeLocation(old.relativeLocation)) continue;
    const listed = entries.filter((entry) => idOf(entry) === id);
    if (!listed.length || listed.some((entry) => !semver.valid(entry.version) || !semver.gt(entry.version, old.version))) continue;
    if (!fs.existsSync(path.join(dir, old.relativeLocation))) continue;
    entries.push(old);
    const keys = Object.keys(obsolete).filter((key) => keyOf(key, id, old.version));
    for (const key of keys) delete obsolete[key];
    held.push({ id, version: old.version, keys });
  }
  if (!held.length) return [];
  writeHeld(dir, [...readHeld(dir).filter((entry) => !held.some((each) => each.id === entry.id && each.version === entry.version)), ...held]);
  writeJson(path.join(dir, INDEX), entries);
  writeObsolete(dir, obsolete);
  return held;
}

// Lets held versions go (all of them without `held`): their entries leave `extensions.json`, and
// their keys go back into `.obsolete`, so that the next code-server deletes their folders. A
// version that is the only one listed of its extension (an update that went back to it) stays.
function releaseVersions(dir, held = null) {
  const all = readHeld(dir);
  const releasing = held ? all.filter((entry) => held.some((each) => each.id === entry.id && each.version === entry.version)) : all;
  if (!releasing.length) return [];
  const entries = readEntries(dir);
  const obsolete = readObsolete(dir);
  for (const { id, version, keys } of releasing) {
    const listed = entries.filter((entry) => idOf(entry) === id);
    const old = listed.filter((entry) => entry.version === version);
    if (old.length && old.length === listed.length) continue;
    for (const entry of old) entries.splice(entries.indexOf(entry), 1);
    for (const key of keys) obsolete[key] = true;
  }
  writeJson(path.join(dir, INDEX), entries);
  writeObsolete(dir, obsolete);
  writeHeld(dir, all.filter((entry) => !releasing.includes(entry)));
  return releasing;
}

module.exports = { HELD, OBSOLETE, holdVersions, readEntries, releaseVersions };
