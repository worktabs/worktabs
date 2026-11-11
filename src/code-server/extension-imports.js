// Local extension payloads are immutable snapshots. Their source never falls back to a gallery.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const zlib = require('zlib');
const AdmZip = require('adm-zip');
const semver = require('semver');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const { t } = require('../i18n');
const { readExtensionIndexSync } = require('./extension-index');

const TARGETS = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];
// Agent extensions bundle native binaries for several platforms (the Codex extension is about
// 1.4 GB unpacked), so this guards against archive bombs rather than budgeting a typical size.
const MAX_BYTES = 4 * 1024 ** 3;
// Archives are read whole, and Node cannot read a file of 2 GiB or more into one buffer.
const MAX_ARCHIVE_BYTES = 2 * 1024 ** 3 - 1;
const MAX_ENTRIES = 50000;
// Files read and compressed ahead of the one being written. Compression runs in the thread
// pool, and this bounds how much of the extension is in memory at once.
const PACK_AHEAD = 4;
const deflateRaw = promisify(zlib.deflateRaw);
const parser = new XMLParser({ ignoreAttributes: false, processEntities: false });

function localTarget() { return `${process.platform}-${process.arch}`; }
// Why an update must wait for a tab: null, 'busy' (a turn in progress or unsaved edits), or
// 'unobserved' (Codex has started but its proxy never reported in, so Worktabs cannot tell
// whether it is working; only closing the tab is safe). codexActive is null when unknown.
function idleWaitReason(tab, { risks = [], codexActive = false } = {}) {
  if (tab.server === 'starting') return 'busy';
  if (tab.server !== 'running') return null;
  if (codexActive !== false && !tab.codexObserved) return 'unobserved';
  return risks.length ? 'busy' : null;
}
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function inside(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function identity(manifest, targetPlatform = 'universal') {
  if (!targetPlatform || targetPlatform === 'undefined') targetPlatform = 'universal';
  const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/.test(id) || !semver.valid(manifest.version)) {
    throw new Error(t('Invalid extension ID or version.'));
  }
  const displayName = typeof manifest.displayName === 'string' && !/^%.*%$/.test(manifest.displayName) ? manifest.displayName : id;
  return { id, name: displayName, version: manifest.version, targetPlatform,
    engine: manifest.engines?.vscode, dependencies: manifest.extensionDependencies || [], manifest };
}

function readFolder(folder, target) {
  const manifest = json(path.join(folder, 'package.json'));
  return { ...identity(manifest, target || manifest.__metadata?.targetPlatform || 'universal'), kind: 'vscode', location: folder };
}

function safeEntries(zip) {
  let size = 0;
  const names = new Set();
  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES) throw new Error(t('The extension archive has too many files.'));
  for (const entry of entries) {
    const name = entry.entryName;
    const parts = name.split('/');
    const mode = (entry.header.attr >>> 16) & 0xf000;
    if (!name || name.startsWith('/') || /[\\:\x00-\x1f]/.test(name) || parts.some((part, index) =>
      (!part && index < parts.length - 1) || part === '..' || part === '.' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part)) || mode === 0xa000) {
      throw new Error(t('The extension archive contains an unsafe path: {path}', { path: name }));
    }
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error(t('The extension archive contains duplicate paths.'));
    names.add(key);
    size += entry.header.size;
    if (size > MAX_BYTES) throw new Error(t('The extension archive is too large.'));
  }
  return entries;
}

function readVsix(file) {
  if (fs.statSync(file).size > MAX_ARCHIVE_BYTES) throw new Error(t('The extension archive is too large.'));
  const zip = new AdmZip(file);
  safeEntries(zip);
  const content = zip.readAsText('extension/package.json');
  if (!content) throw new Error(t('The VSIX has no extension manifest.'));
  const xml = zip.readAsText('extension.vsixmanifest');
  if (!xml || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error(t('Invalid VSIX metadata.'));
  const metadata = parser.parse(xml)?.PackageManifest?.Metadata;
  const target = metadata?.Identity?.['@_TargetPlatform'] || 'universal';
  const item = identity(JSON.parse(content), target);
  if (metadata?.Identity?.['@_Version'] !== item.version || `${metadata?.Identity?.['@_Publisher']}.${metadata?.Identity?.['@_Id']}`.toLowerCase() !== item.id) {
    throw new Error(t('The VSIX metadata does not match its extension manifest.'));
  }
  return { ...item, kind: 'vsix', location: file };
}

function installedExtensions(root) {
  if (!fs.existsSync(path.join(root, 'extensions.json'))) return [];
  let inventory;
  try { inventory = readExtensionIndexSync(root, { strict: true }); }
  catch (error) {
    if (error.code === 'INVALID_EXTENSION_INDEX') throw new Error(t('Invalid extension list.'), { cause: error });
    throw error;
  }
  return inventory.entries.map((entry) => {
    const location = path.resolve(root, entry.relativeLocation || '');
    if (!inside(root, location)) throw new Error(t('An extension is outside the selected folder.'));
    const item = readFolder(location, entry.declaredTargetPlatform);
    if (item.id !== entry.id || item.version !== entry.version) throw new Error(t('An installed extension does not match its extension list.'));
    return item;
  });
}

function discoverDesktop({ home = os.homedir(), env = process.env } = {}) {
  const roots = [env.VSCODE_EXTENSIONS, path.join(home, '.vscode', 'extensions'), path.join(home, '.vscode-insiders', 'extensions')].filter(Boolean);
  /** @type {Array<Partial<ReturnType<typeof readFolder>> & { root: string, error?: string }>} */
  const result = [];
  for (const root of new Set(roots)) {
    if (!fs.existsSync(path.join(root, 'extensions.json'))) continue;
    try { result.push(...installedExtensions(root).map((item) => ({ ...item, root }))); }
    catch (error) { result.push({ root, error: error.message }); }
  }
  return result;
}

function validateBatch(items, { target, vscode, installed = [], protectedIds = [] }) {
  if (!TARGETS.includes(target)) throw new Error(t('Unsupported extension target.'));
  if (!items.length) throw new Error(t('Select at least one extension.'));
  const ids = new Set();
  const have = new Set(installed.map((item) => item.id.toLowerCase()));
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(t('Select only one version of each extension.'));
    ids.add(item.id);
    if (protectedIds.includes(item.id) || item.manifest.contributes?.localizations?.length) throw new Error(t('{name} is managed by Worktabs.', { name: item.name }));
    const compatible = item.targetPlatform === 'universal' || item.targetPlatform === target || (target.startsWith('darwin-') && item.targetPlatform === 'darwin-universal');
    if (!compatible) throw new Error(t('{name} targets {actual}, not {target}.', { name: item.name, actual: item.targetPlatform, target }));
    if (!item.engine || !semver.validRange(item.engine) || !semver.satisfies(vscode, item.engine, { includePrerelease: true })) {
      throw new Error(t('{name} requires VS Code {version}.', { name: item.name, version: item.engine || '?' }));
    }
    if (!Array.isArray(item.dependencies) || item.dependencies.some((id) => typeof id !== 'string')) throw new Error(t('Invalid extension dependencies.'));
  }
  for (const item of items) {
    const missing = item.dependencies.filter((id) => !ids.has(id.toLowerCase()) && !have.has(id.toLowerCase()));
    if (missing.length) throw new Error(t('{name} needs these extensions: {extensions}', { name: item.name, extensions: missing.join(', ') }));
  }
}

function walkFiles(root, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    const file = path.join(root, relative);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error(t('The extension contains an unsupported file: {path}', { path: file }));
    if (entry.isDirectory()) files.push(...walkFiles(root, relative));
    else files.push({ file, relative: relative.split(path.sep).join('/'), stat: fs.statSync(file) });
  }
  return files;
}

function dosDateTime(date) {
  return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() };
}

// Writes entries one at a time, so memory follows the largest file rather than the whole
// extension (building the archive in memory took over 3 GB for the Codex extension).
// The archive stays under 2 GiB and MAX_ENTRIES, so plain zip fields hold every offset and count.
async function writeVsix(destination, entries) {
  const handle = await fs.promises.open(destination, 'w');
  const central = [];
  let offset = 0;
  const write = async (buffer) => {
    if (offset + buffer.length > MAX_ARCHIVE_BYTES) throw new Error(t('The extension archive is too large.'));
    await handle.write(buffer);
    offset += buffer.length;
  };
  const compress = async ({ name, read, mtime = new Date(), mode = 0o644 }) => {
    const data = await read();
    return { name, data, mtime, mode, deflated: data.length ? await deflateRaw(data) : data };
  };
  try {
    const pending = [];
    let next = 0;
    while (next < entries.length || pending.length) {
      while (next < entries.length && pending.length < PACK_AHEAD) {
        const job = compress(entries[next++]);
        job.catch(() => {}); // Awaited in order below; an earlier failure must not leave it unhandled.
        pending.push(job);
      }
      const { name, data, mtime, mode, deflated } = await pending.shift();
      const nameBytes = Buffer.from(name);
      const { time, date } = dosDateTime(mtime);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6); // Names are UTF-8.
      local.writeUInt16LE(data.length ? 8 : 0, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(zlib.crc32(data), 14);
      local.writeUInt32LE(deflated.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBytes.length, 26);
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(0x0314, 4); // Made on Unix, so readers take the mode from the high attribute bits.
      local.copy(entry, 6, 4, 30);
      entry.writeUInt32LE(((0x8000 | (mode & 0xfff)) << 16) >>> 0, 38);
      entry.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([entry, nameBytes]));
      await write(Buffer.concat([local, nameBytes]));
      await write(deflated);
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    await write(Buffer.concat([directory, end]));
  } finally {
    await handle.close();
  }
}

async function folderVsix(item, destination) {
  const files = walkFiles(item.location);
  if (files.length + 2 > MAX_ENTRIES) throw new Error(t('The extension archive has too many files.'));
  if (files.reduce((size, { stat }) => size + stat.size, 0) > MAX_BYTES) throw new Error(t('The extension is too large.'));
  const xml = new XMLBuilder({ ignoreAttributes: false }).build({ PackageManifest: {
    '@_Version': '2.0.0', '@_xmlns': 'http://schemas.microsoft.com/developer/vsx-schema/2011',
    Metadata: { Identity: { '@_Language': 'en-US', '@_Id': item.manifest.name, '@_Version': item.version, '@_Publisher': item.manifest.publisher, '@_TargetPlatform': item.targetPlatform }, DisplayName: item.name, Description: { '@_xml:space': 'preserve', '#text': item.manifest.description || item.name }, Properties: { Property: { '@_Id': 'Microsoft.VisualStudio.Code.Engine', '@_Value': item.engine } } },
    Installation: { InstallationTarget: { '@_Id': 'Microsoft.VisualStudio.Code' } },
    Dependencies: '', Assets: { Asset: { '@_Type': 'Microsoft.VisualStudio.Code.Manifest', '@_Path': 'extension/package.json', '@_Addressable': 'true' } },
  } });
  const types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>';
  await writeVsix(destination, [
    ...files.map(({ file, relative, stat }) => ({ name: `extension/${relative}`, read: () => fs.promises.readFile(file), mtime: stat.mtime, mode: stat.mode })),
    { name: 'extension.vsixmanifest', read: async () => Buffer.from(xml) },
    { name: '[Content_Types].xml', read: async () => Buffer.from(types) },
  ]);
}

// Snapshots run to hundreds of MB, so hash them in chunks rather than reading them whole.
function sha256(file) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(4 * 1024 ** 2);
  const fd = fs.openSync(file, 'r');
  try {
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

class ExtensionImports {
  constructor(root) { this.root = root; this.file = path.join(root, 'imports.json'); }
  state() {
    if (!fs.existsSync(this.file)) return {};
    const data = json(this.file);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(t('Invalid imported extension state.'));
    return data;
  }
  records(target) { return Object.values(this.state()[target] || {}); }
  write(state) {
    fs.mkdirSync(this.root, { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(temp, this.file);
  }
  // `download(item, file)`: writes a release from Open VSX (open-vsx.js), for item.kind 'openvsx'.
  /** @param {any} item @param {string} target @param {{ download?: (item: any, file: string) => Promise<void> }} [options] */
  async stage(item, target, { download } = {}) {
    if (!TARGETS.includes(target)) throw new Error(t('Unsupported extension target.'));
    const dir = path.join(this.root, 'packages', target, crypto.randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${item.id}-${item.version}.vsix`);
    try {
      if (item.kind === 'vsix') await fs.promises.copyFile(item.location, file);
      else if (item.kind === 'openvsx') {
        if (!download) throw new Error(t('Downloading from Open VSX is not available.'));
        await download(item, file);
      } else await folderVsix(item, file);
      const checked = readVsix(file);
      if (checked.id !== item.id || checked.version !== item.version || checked.targetPlatform !== item.targetPlatform) throw new Error(t('The source changed while importing. Refresh and try again.'));
    } catch (error) {
      // A failed pack can leave up to 2 GiB behind, and no record will ever point at it.
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    const source = item.snapshotSource || (item.kind === 'openvsx' ? { kind: 'openvsx', location: item.page, root: null } : { kind: item.kind, location: item.location, root: item.root || null });
    // The members of an Open VSX extension pack, which are updated and restored with it.
    const bundled = item.kind === 'openvsx' ? item.bundled || [] : item.bundled;
    return { id: item.id, name: item.name, version: item.version, targetPlatform: item.targetPlatform, file, sha256: sha256(file), source, ...(bundled?.length ? { bundled } : {}) };
  }
  package(record) {
    if (!inside(this.root, record.file) || sha256(record.file) !== record.sha256) throw new Error(t('An imported extension snapshot is missing or has changed.'));
    return record.file;
  }
  commit(target, records, previous) {
    const state = this.state();
    state[target] ||= {};
    for (const record of records) {
      const old = previous.find((item) => item.id === record.id);
      const { previous: _older, ...snapshot } = old || {};
      state[target][record.id] = { ...record, previous: old ? snapshot : null };
    }
    this.write(state);
  }
  // Deletes the staged packages that no record keeps as its current or previous snapshot, and
  // returns their folders. Each stage makes a folder of its own, and a record keeps only one
  // previous snapshot, so without this every import leaves a few hundred MB behind. Call it only
  // between batches: a staged snapshot has no record until its batch commits. Unreadable
  // records delete nothing, as they are what tells which packages are in use. A package is
  // matched by its <target>/<folder> (a UUID), not its full path, so that a data folder that
  // moved, or a path written in other case or slashes, does not lose every snapshot.
  prune({ platform = process.platform } = {}) {
    let state;
    try { state = this.state(); } catch { return []; }
    const key = (dir) => {
      const parts = dir.split(/[\\/]+/).filter(Boolean).slice(-2).join('/');
      return platform === 'win32' ? parts.toLowerCase() : parts;
    };
    const kept = new Set();
    for (const records of Object.values(state)) {
      for (const record of Object.values(records || {})) {
        for (const snapshot of [record, record?.previous]) {
          if (typeof snapshot?.file === 'string') kept.add(key(snapshot.file.replace(/[\\/]+[^\\/]*$/, '')));
        }
      }
    }
    const folders = (dir) => {
      try { return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name)); }
      catch { return []; }
    };
    const removed = [];
    for (const target of folders(path.join(this.root, 'packages'))) {
      for (const dir of folders(target)) {
        if (kept.has(key(dir))) continue;
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
          removed.push(dir);
        } catch { /* Still open somewhere: the next prune tries again. */ }
      }
    }
    return removed;
  }
  localUpdates(target) {
    const updates = [];
    for (const record of this.records(target)) {
      if (record.source.kind !== 'vscode' || !record.source.root) continue;
      try {
        const source = installedExtensions(record.source.root).find((item) => item.id === record.id && item.targetPlatform === record.targetPlatform);
        if (source && semver.gt(source.version, record.version)) updates.push({ kind: 'import', id: record.id, name: record.name, from: record.version, to: source.version, target, candidate: { ...source, root: record.source.root } });
      } catch { /* An unavailable source is not proof that the snapshot is current. */ }
    }
    return updates;
  }
}

async function applyImportBatch({ records, previous, install, uninstall, probe, commit }) {
  const applied = [];
  try {
    for (const record of records) { applied.push(record); await install(record); }
    await probe();
    await commit();
  } catch (error) {
    const failures = [];
    for (const record of applied.reverse()) {
      try {
        const old = previous.find((item) => item.id === record.id);
        if (old) await install(old);
        else await uninstall(record.id);
      } catch (failure) { failures.push(failure.message); }
    }
    if (failures.length) throw new Error(t('{error}. Restoration failed: {details}', { error: error.message, details: failures.join('\n') }), { cause: error });
    throw error;
  }
}

module.exports = { TARGETS, ExtensionImports, applyImportBatch, discoverDesktop, identity, installedExtensions, localTarget, idleWaitReason, readFolder, readVsix, safeEntries, validateBatch };
