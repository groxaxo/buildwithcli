'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  BuildWithCliError, MANIFEST_VERSION, isPlainObject, sha256,
} = require('./base');
const { resolveFormatRoot } = require('./targets');
const { isPathInside, assertNoSymlinkTraversal } = require('./render');

function buildAllowedRootsByTarget(targets, scope, context) {
  const allowed = {};
  for (const [targetId, target] of Object.entries(targets)) {
    const roots = {};
    for (const kind of ['agent', 'command', 'skill']) {
      try {
        roots[kind] = path.resolve(resolveFormatRoot(target, scope, kind, context).root);
      } catch (error) {
        if (!['UNSUPPORTED_SCOPE', 'UNSUPPORTED_RESOURCE'].includes(error.code)) throw error;
      }
    }
    if (Object.keys(roots).length) allowed[targetId] = roots;
  }
  return allowed;
}

function validateManifestTargetRoots(entry, allowedRootsByTarget, manifestPath, targetIds = entry.targetIds) {
  if (!allowedRootsByTarget) {
    if (entry.scope === 'user') {
      throw new BuildWithCliError(
        `User manifest roots require target-profile validation: ${manifestPath}`,
        { code: 'UNTRUSTED_MANIFEST_ROOT' },
      );
    }
    return;
  }
  for (const targetId of targetIds) {
    const expected = allowedRootsByTarget[targetId]?.[entry.sourceKind];
    if (!expected) {
      throw new BuildWithCliError(
        `Manifest target '${targetId}' is unavailable; load the original custom profile before modifying this manifest`,
        { code: 'UNKNOWN_MANIFEST_TARGET' },
      );
    }
    if (path.resolve(expected) !== path.resolve(entry.root)) {
      throw new BuildWithCliError(
        `Manifest root does not match target '${targetId}' ${entry.sourceKind} root: ${entry.root}`,
        { code: 'UNTRUSTED_MANIFEST_ROOT' },
      );
    }
  }
}

function manifestPathFor(scope, context) {
  return scope === 'project'
    ? path.join(context.projectRoot, '.buildwithcli', 'manifest.json')
    : path.join(context.home, '.buildwithcli', 'manifest.json');
}

async function loadManifest(manifestPath, manifestBoundaryRoot = null) {
  const stat = await fsp.lstat(manifestPath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return { version: MANIFEST_VERSION, entries: [] };
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new BuildWithCliError(`Manifest must be a regular file, not a symlink or directory: ${manifestPath}`, {
      code: 'INVALID_MANIFEST',
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new BuildWithCliError(`Manifest is not valid JSON: ${manifestPath}: ${error.message}`, {
      code: 'INVALID_MANIFEST',
    });
  }
  if (parsed.version !== MANIFEST_VERSION || !Array.isArray(parsed.entries)) {
    throw new BuildWithCliError(`Unsupported or invalid manifest: ${manifestPath}`, {
      code: 'INVALID_MANIFEST',
    });
  }

  const seenDestinations = new Set();
  for (const entry of parsed.entries) {
    const valid = isPlainObject(entry)
      && ['project', 'user'].includes(entry.scope)
      && ['agent', 'command', 'skill'].includes(entry.sourceKind)
      && typeof entry.sourceName === 'string'
      && typeof entry.outputName === 'string'
      && typeof entry.sourcePath === 'string'
      && typeof entry.destination === 'string'
      && typeof entry.root === 'string'
      && path.isAbsolute(entry.destination)
      && path.isAbsolute(entry.root)
      && typeof entry.sha256 === 'string'
      && /^[a-f0-9]{64}$/.test(entry.sha256)
      && Number.isInteger(entry.mode)
      && entry.mode >= 0
      && entry.mode <= 0o777
      && typeof entry.format === 'string'
      && Array.isArray(entry.targetIds)
      && entry.targetIds.length > 0
      && entry.targetIds.every((targetId) => typeof targetId === 'string' && targetId.length > 0)
      && (entry.boundaryRoot === null || entry.boundaryRoot === undefined || (typeof entry.boundaryRoot === 'string' && path.isAbsolute(entry.boundaryRoot)));
    if (!valid) {
      throw new BuildWithCliError(`Manifest contains an invalid entry: ${manifestPath}`, {
        code: 'INVALID_MANIFEST',
      });
    }
    const destinationKey = path.resolve(entry.destination);
    if (seenDestinations.has(destinationKey)) {
      throw new BuildWithCliError(`Manifest contains duplicate destinations: ${entry.destination}`, {
        code: 'INVALID_MANIFEST',
      });
    }
    seenDestinations.add(destinationKey);
    if (!isPathInside(entry.root, entry.destination)) {
      throw new BuildWithCliError(`Manifest destination escapes its recorded target root: ${entry.destination}`, {
        code: 'UNSAFE_DESTINATION',
      });
    }
    if (entry.boundaryRoot && !isPathInside(entry.boundaryRoot, entry.root)) {
      throw new BuildWithCliError(`Manifest target root escapes its recorded boundary: ${entry.root}`, {
        code: 'UNSAFE_DESTINATION',
      });
    }
    const effectiveBoundary = entry.boundaryRoot
      || (entry.scope === 'project' ? manifestBoundaryRoot : null);
    await assertNoSymlinkTraversal(entry.root, entry.destination, effectiveBoundary);
  }
  return parsed;
}

async function hashExistingFile(destination) {
  const stat = await fsp.lstat(destination).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  if (stat.isSymbolicLink()) {
    throw new BuildWithCliError(`Refusing symlink destination: ${destination}`, {
      code: 'DESTINATION_SYMLINK',
    });
  }
  if (!stat.isFile()) {
    throw new BuildWithCliError(`Destination exists and is not a file: ${destination}`, {
      code: 'DESTINATION_NOT_FILE',
    });
  }
  return { hash: sha256(await fsp.readFile(destination)), mode: stat.mode & 0o777 };
}

function sameFileState(left, right) {
  if (!left || !right) return !left && !right;
  return left.hash === right.hash && left.mode === right.mode;
}

async function readManifestSnapshot(manifestPath, manifestBoundaryRoot = null) {
  const before = await hashExistingFile(manifestPath);
  const manifest = await loadManifest(manifestPath, manifestBoundaryRoot);
  const after = await hashExistingFile(manifestPath);
  if (!sameFileState(before, after)) {
    throw new BuildWithCliError(`Manifest changed while it was being read: ${manifestPath}`, {
      code: 'MANIFEST_CHANGED',
      exitCode: 2,
    });
  }
  return { manifest, state: after };
}

function sameLogicalManifestEntry(entry, operation) {
  return Boolean(entry)
    && entry.sourceKind === operation.sourceKind
    && entry.sourceName === operation.sourceName
    && entry.outputName === operation.outputName
    && path.resolve(entry.root) === path.resolve(operation.root);
}

async function preflightProjection(plan, manifest, options = {}) {
  const manifestEntries = new Map(manifest.entries.map((entry) => [path.resolve(entry.destination), entry]));
  const statuses = [];
  const conflicts = [];
  for (const operation of plan.operations) {
    await assertNoSymlinkTraversal(operation.root, operation.destination, operation.boundaryRoot);
    const desiredHash = sha256(operation.content);
    const existing = await hashExistingFile(operation.destination);
    const tracked = manifestEntries.get(path.resolve(operation.destination));
    const sameLogicalResource = sameLogicalManifestEntry(tracked, operation);
    const trackedMatchesExisting = Boolean(tracked && existing
      && tracked.sha256 === existing.hash
      && tracked.mode === existing.mode);

    let status;
    if (!existing) {
      if (tracked && !sameLogicalResource && !options.force) status = 'conflict';
      else status = 'create';
    } else if (sameLogicalResource && trackedMatchesExisting) {
      status = existing.hash === desiredHash && existing.mode === operation.mode ? 'noop' : 'update';
    } else if (options.force) {
      status = 'update';
    } else {
      status = 'conflict';
    }

    if (status === 'conflict') {
      conflicts.push({
        operation,
        existingHash: existing?.hash || null,
        desiredHash,
        tracked: tracked || null,
      });
    }
    statuses.push({ operation, status, desiredHash, previous: existing });
  }
  return { statuses, conflicts };
}

async function writeFileAtomic(destination, content, mode = 0o644) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temp = path.join(path.dirname(destination), `.${path.basename(destination)}.buildwithcli-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  await fsp.writeFile(temp, content, { mode, flag: 'wx' });
  await fsp.chmod(temp, mode);
  return temp;
}

module.exports = {
  buildAllowedRootsByTarget, validateManifestTargetRoots, manifestPathFor,
  loadManifest, hashExistingFile, sameFileState, readManifestSnapshot,
  sameLogicalManifestEntry, preflightProjection, writeFileAtomic,
};
