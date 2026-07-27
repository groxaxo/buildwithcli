'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { generationTimestamp, sha256, toPosix } = require('./util');

const MANIFEST_NAME = '.buildwithcli-manifest.json';
const DEFAULT_IGNORES = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.next', 'dist', 'build', 'coverage',
  '.cache', '.turbo', '.buildwithcli', '.buildwithcli-backup', '__pycache__', '.venv', 'venv', '.DS_Store',
]);

function resolveInside(root, relative, label = 'path') {
  if (typeof relative !== 'string' || relative.includes('\0')) throw new Error(`Invalid ${label}`);
  const normalized = relative.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`${label} escapes root: ${relative}`);
  }
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, normalized);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`${label} escapes root: ${relative}`);
  }
  return absolute;
}

async function lstatOptional(filePath) {
  try {
    return await fsp.lstat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertRootSafe(root, { create = false } = {}) {
  const absolute = path.resolve(root);
  const stat = await lstatOptional(absolute);
  if (stat) {
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink root: ${absolute}`);
    if (!stat.isDirectory()) throw new Error(`Expected directory: ${absolute}`);
    return absolute;
  }
  const missing = [];
  let current = absolute;
  while (true) {
    const currentStat = await lstatOptional(current);
    if (currentStat) {
      if (currentStat.isSymbolicLink()) throw new Error(`Refusing symlink ancestor: ${current}`);
      if (!currentStat.isDirectory()) throw new Error(`Expected directory ancestor: ${current}`);
      break;
    }
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Cannot locate existing ancestor for: ${absolute}`);
    current = parent;
  }
  // Re-check every existing component. A missing output path may sit below a
  // symlink several levels up; recursive mkdir would otherwise follow it.
  const parsed = path.parse(current);
  let component = parsed.root;
  for (const part of current.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    component = path.join(component, part);
    const componentStat = await lstatOptional(component);
    if (componentStat?.isSymbolicLink()) throw new Error(`Refusing symlink ancestor: ${component}`);
  }
  if (create) {
    for (const directory of missing.reverse()) {
      try {
        await fsp.mkdir(directory);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const createdStat = await fsp.lstat(directory);
      if (createdStat.isSymbolicLink()) throw new Error(`Refusing symlink created during root setup: ${directory}`);
      if (!createdStat.isDirectory()) throw new Error(`Expected directory created during root setup: ${directory}`);
    }
  }
  return absolute;
}

async function assertNoSymlinkComponents(root, target, includeLeaf = true) {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  if (absoluteTarget !== absoluteRoot && !absoluteTarget.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`Path escapes root: ${target}`);
  }
  const rootStat = await lstatOptional(absoluteRoot);
  if (rootStat?.isSymbolicLink()) throw new Error(`Refusing symlink root: ${absoluteRoot}`);
  const relative = path.relative(absoluteRoot, absoluteTarget);
  const parts = relative ? relative.split(path.sep) : [];
  const limit = includeLeaf ? parts.length : Math.max(0, parts.length - 1);
  let current = absoluteRoot;
  for (let i = 0; i < limit; i += 1) {
    current = path.join(current, parts[i]);
    const stat = await lstatOptional(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink component: ${current}`);
  }
}

async function readFileLimited(filePath, maxBytes = 2 * 1024 * 1024) {
  const stat = await fsp.lstat(filePath);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to read symlink: ${filePath}`);
  if (!stat.isFile()) throw new Error(`Expected regular file: ${filePath}`);
  if (stat.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes: ${filePath}`);
  return fsp.readFile(filePath);
}

async function walkFiles(root, options = {}) {
  const absoluteRoot = await assertRootSafe(root);
  const maxFiles = options.maxFiles ?? 100000;
  const maxDepth = options.maxDepth ?? 32;
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
  const ignores = new Set([...DEFAULT_IGNORES, ...(options.ignoreNames || [])]);
  const files = [];
  let totalBytes = 0;

  async function visit(directory, depth) {
    if (depth > maxDepth) throw new Error(`Directory depth exceeds ${maxDepth}: ${directory}`);
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (ignores.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (options.rejectSymlinks !== false) throw new Error(`Refusing symlink while scanning: ${absolute}`);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolute, depth + 1);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(absolute);
        totalBytes += stat.size;
        if (totalBytes > maxBytes) throw new Error(`Scan exceeds ${maxBytes} bytes under ${absoluteRoot}`);
        files.push({
          absolute,
          relative: toPosix(path.relative(absoluteRoot, absolute)),
          size: stat.size,
          mode: stat.mode & 0o777,
        });
        if (files.length > maxFiles) throw new Error(`Scan exceeds ${maxFiles} files under ${absoluteRoot}`);
      }
    }
  }

  await visit(absoluteRoot, 0);
  return files;
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeManagedPath(relative, label = 'managed path') {
  const rel = toPosix(relative).replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  if (!rel || rel === MANIFEST_NAME || path.posix.isAbsolute(rel) || rel.split('/').includes('..') || rel.includes('\0')) {
    throw new Error(`Unsafe ${label}: ${relative}`);
  }
  return rel;
}

function validateManifest(data, file) {
  if (!data || typeof data !== 'object' || data.schemaVersion !== 1 || data.generator !== 'buildwithcli' || !Array.isArray(data.files)) {
    throw new Error(`Invalid BuildWithCLI manifest: ${file}`);
  }
  const seen = new Set();
  for (const entry of data.files) {
    if (!entry || typeof entry !== 'object') throw new Error(`Invalid manifest entry in ${file}`);
    const relative = normalizeManagedPath(entry.path, 'manifest path');
    if (seen.has(relative)) throw new Error(`Duplicate manifest path: ${relative}`);
    if (!/^[a-f0-9]{64}$/.test(String(entry.sha256 || ''))) throw new Error(`Invalid manifest hash for ${relative}`);
    seen.add(relative);
    entry.path = relative;
  }
  return data;
}

async function loadManifest(root) {
  const file = path.join(root, MANIFEST_NAME);
  if (!(await fileExists(file))) return null;
  await assertNoSymlinkComponents(root, file);
  const data = JSON.parse((await readFileLimited(file, 8 * 1024 * 1024)).toString('utf8'));
  return validateManifest(data, file);
}

async function syncDirectory(directory) {
  try {
    const handle = await fsp.open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    // Directory fsync is not available on every platform/filesystem.
    if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(error.code)) throw error;
  }
}

async function writeAtomic(filePath, bytes, mode = 0o644) {
  const directory = path.dirname(filePath);
  await fsp.mkdir(directory, { recursive: true });
  const directoryStat = await fsp.lstat(directory);
  if (directoryStat.isSymbolicLink()) throw new Error(`Refusing symlink output directory: ${directory}`);
  if (!directoryStat.isDirectory()) throw new Error(`Expected output directory: ${directory}`);
  const leafStat = await lstatOptional(filePath);
  if (leafStat?.isSymbolicLink()) throw new Error(`Refusing to overwrite symlink: ${filePath}`);
  if (leafStat && !leafStat.isFile()) throw new Error(`Refusing to overwrite non-file: ${filePath}`);
  const temp = path.join(directory, `.${path.basename(filePath)}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`);
  let handle;
  try {
    handle = await fsp.open(temp, 'wx', mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temp, filePath);
    await fsp.chmod(filePath, mode);
    await syncDirectory(directory);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(temp, { force: true }).catch(() => {});
  }
}

function normalizeFileMap(fileMap, options = {}) {
  if (!(fileMap instanceof Map)) throw new Error('Generated files must be a Map');
  const maxFiles = options.maxOutputFiles ?? 100000;
  const maxBytes = options.maxOutputBytes ?? 512 * 1024 * 1024;
  if (fileMap.size > maxFiles) throw new Error(`Generated output exceeds ${maxFiles} files`);
  const result = new Map();
  let totalBytes = 0;
  for (const [relative, entryValue] of fileMap.entries()) {
    const rel = normalizeManagedPath(relative, 'generated path');
    if (result.has(rel)) throw new Error(`Generated path collision: ${rel}`);
    const entry = Buffer.isBuffer(entryValue) || typeof entryValue === 'string'
      ? { content: entryValue, mode: 0o644 }
      : entryValue;
    if (!entry || entry.content == null) throw new Error(`Generated file has no content: ${rel}`);
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content), 'utf8');
    totalBytes += content.length;
    if (totalBytes > maxBytes) throw new Error(`Generated output exceeds ${maxBytes} bytes`);
    const mode = Number(entry.mode ?? 0o644);
    if (!Number.isInteger(mode) || mode < 0o600 || mode > 0o755) throw new Error(`Unsafe mode for ${rel}: ${mode.toString(8)}`);
    result.set(rel, { content, mode, source: entry.source || null });
  }
  return result;
}

async function applyFileMap(root, fileMap, options = {}) {
  const absoluteRoot = await assertRootSafe(root);
  const normalized = normalizeFileMap(fileMap, options);
  const previous = await loadManifest(absoluteRoot).catch((error) => {
    if (options.forceManifest) return null;
    throw error;
  });
  const previousFiles = new Map((previous?.files || []).map((entry) => [entry.path, entry]));
  const operations = [];

  for (const [relative, entry] of normalized.entries()) {
    const destination = resolveInside(absoluteRoot, relative, 'generated path');
    await assertNoSymlinkComponents(absoluteRoot, destination, true);
    const hash = sha256(entry.content);
    const stat = await lstatOptional(destination);
    if (!stat) {
      operations.push({ action: 'create', path: relative, hash, mode: entry.mode });
      continue;
    }
    if (stat.isSymbolicLink()) throw new Error(`Refusing to overwrite symlink: ${destination}`);
    if (!stat.isFile()) throw new Error(`Refusing to overwrite non-file: ${destination}`);
    const existingHash = sha256(await fsp.readFile(destination));
    const existingMode = stat.mode & 0o777;
    if (existingHash === hash) {
      operations.push({ action: existingMode === entry.mode ? 'unchanged' : 'chmod', path: relative, hash, mode: entry.mode });
      continue;
    }
    const previousEntry = previousFiles.get(relative);
    const previouslyManaged = Boolean(previousEntry);
    const unmodifiedManaged = previousEntry?.sha256 === existingHash;
    if (previouslyManaged && !unmodifiedManaged && !options.force) {
      throw new Error(`Managed file changed since generation: ${relative}. Use --force after reviewing the local edits.`);
    }
    if (!previouslyManaged && !options.replaceUnmanaged) {
      throw new Error(`Refusing to overwrite unmanaged file: ${relative}. Use --replace-unmanaged explicitly.`);
    }
    operations.push({ action: 'update', path: relative, hash, mode: entry.mode });
  }

  const generatedPaths = new Set(normalized.keys());
  if (options.clean && previous) {
    for (const old of previous.files) {
      if (generatedPaths.has(old.path)) continue;
      const destination = resolveInside(absoluteRoot, old.path, 'managed path');
      const stat = await lstatOptional(destination);
      if (!stat) continue;
      await assertNoSymlinkComponents(absoluteRoot, destination, true);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing to clean non-regular managed path: ${old.path}`);
      const currentHash = sha256(await fsp.readFile(destination));
      if (currentHash !== old.sha256 && !options.force) {
        throw new Error(`Refusing to remove modified managed file: ${old.path}`);
      }
      operations.push({ action: 'remove', path: old.path });
    }
  }

  const stamp = generationTimestamp(options.stamp);
  const manifest = {
    schemaVersion: 1,
    generator: 'buildwithcli',
    target: options.target || 'unknown',
    source: options.source || null,
    ...(stamp ? { generatedAt: stamp } : {}),
    files: [...normalized.entries()].map(([relative, entry]) => ({
      path: relative,
      sha256: sha256(entry.content),
      mode: entry.mode,
      source: entry.source,
    })).sort((a, b) => a.path.localeCompare(b.path)),
  };

  if (options.dryRun) return { operations, manifest };

  await assertRootSafe(absoluteRoot, { create: true });
  for (const operation of operations.filter((item) => item.action === 'remove')) {
    await fsp.rm(resolveInside(absoluteRoot, operation.path));
  }
  const operationByPath = new Map(operations.map((operation) => [operation.path, operation]));
  for (const [relative, entry] of normalized.entries()) {
    const operation = operationByPath.get(relative);
    if (!operation || operation.action === 'unchanged') continue;
    const destination = resolveInside(absoluteRoot, relative, 'generated path');
    await assertNoSymlinkComponents(absoluteRoot, destination, false);
    if (operation.action === 'chmod') {
      await assertNoSymlinkComponents(absoluteRoot, destination, true);
      await fsp.chmod(destination, entry.mode);
    } else {
      await writeAtomic(destination, entry.content, entry.mode);
      await assertNoSymlinkComponents(absoluteRoot, destination, true);
    }
  }
  await writeAtomic(path.join(absoluteRoot, MANIFEST_NAME), Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), 0o644);
  return { operations, manifest };
}

module.exports = {
  DEFAULT_IGNORES,
  MANIFEST_NAME,
  applyFileMap,
  assertNoSymlinkComponents,
  assertRootSafe,
  fileExists,
  loadManifest,
  normalizeFileMap,
  readFileLimited,
  resolveInside,
  walkFiles,
  writeAtomic,
};
