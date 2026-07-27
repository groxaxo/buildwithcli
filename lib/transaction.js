'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { BuildWithCliError, MANIFEST_VERSION, VERSION, sha256 } = require('./base');
const { selectorMatches } = require('./catalog');
const { isPathInside, assertNoSymlinkTraversal } = require('./render');
const {
  validateManifestTargetRoots, loadManifest, hashExistingFile, sameFileState,
  readManifestSnapshot, preflightProjection, writeFileAtomic,
} = require('./manifest');

async function applyProjection(plan, options = {}) {
  const manifestPath = path.resolve(options.manifestPath);
  await assertNoSymlinkTraversal(
    path.dirname(manifestPath),
    manifestPath,
    options.manifestBoundaryRoot || null,
  );
  const manifestSnapshot = await readManifestSnapshot(
    manifestPath,
    options.manifestBoundaryRoot || null,
  );
  const manifest = manifestSnapshot.manifest;
  const preflight = await preflightProjection(plan, manifest, options);
  if (preflight.conflicts.length) {
    throw new BuildWithCliError(
      `Refusing to overwrite ${preflight.conflicts.length} untracked or locally modified file(s). Re-run with --force to replace them.`,
      { code: 'DESTINATION_CONFLICT', exitCode: 2, details: preflight.conflicts },
    );
  }
  if (options.dryRun) return { ...preflight, manifestPath, dryRun: true };

  const staged = [];
  const committed = [];
  let manifestTemp = null;
  let oldManifestBackup = null;
  let manifestCommitted = false;
  try {
    for (const item of preflight.statuses) {
      if (item.status === 'noop') continue;
      await assertNoSymlinkTraversal(item.operation.root, item.operation.destination, item.operation.boundaryRoot);
      const temp = await writeFileAtomic(item.operation.destination, item.operation.content, item.operation.mode);
      staged.push({ ...item, temp, backup: null });
    }

    for (const item of staged) {
      await assertNoSymlinkTraversal(item.operation.root, item.operation.destination, item.operation.boundaryRoot);
      const current = await hashExistingFile(item.operation.destination);
      if (!sameFileState(current, item.previous)) {
        throw new BuildWithCliError(`Destination changed after preflight: ${item.operation.destination}`, {
          code: 'DESTINATION_CHANGED',
          exitCode: 2,
        });
      }
      if (current) {
        item.backup = `${item.operation.destination}.buildwithcli-backup-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
        await fsp.rename(item.operation.destination, item.backup);
      }
      try {
        await fsp.rename(item.temp, item.operation.destination);
        item.temp = null;
        committed.push(item);
      } catch (error) {
        if (item.backup) {
          await fsp.rename(item.backup, item.operation.destination).catch(() => {});
          item.backup = null;
        }
        throw error;
      }
    }

    for (const item of preflight.statuses) {
      await assertNoSymlinkTraversal(item.operation.root, item.operation.destination, item.operation.boundaryRoot);
      const current = await hashExistingFile(item.operation.destination);
      if (!current || current.hash !== item.desiredHash || current.mode !== item.operation.mode) {
        throw new BuildWithCliError(`Destination changed before manifest commit: ${item.operation.destination}`, {
          code: 'DESTINATION_CHANGED',
          exitCode: 2,
        });
      }
    }

    const nextByDestination = new Map(manifest.entries.map((entry) => [path.resolve(entry.destination), entry]));
    for (const item of preflight.statuses) {
      const destination = path.resolve(item.operation.destination);
      const previous = nextByDestination.get(destination);
      const sameLogicalResource = previous
        && previous.sourceKind === item.operation.sourceKind
        && previous.sourceName === item.operation.sourceName
        && previous.outputName === item.operation.outputName;
      const targetIds = sameLogicalResource
        ? [...new Set([...(previous.targetIds || []), ...item.operation.targetIds])].sort()
        : [...item.operation.targetIds].sort();
      nextByDestination.set(destination, {
        targetIds,
        sourceKind: item.operation.sourceKind,
        sourceName: item.operation.sourceName,
        outputName: item.operation.outputName,
        sourcePath: item.operation.sourcePath,
        root: path.resolve(item.operation.root),
        boundaryRoot: item.operation.boundaryRoot ? path.resolve(item.operation.boundaryRoot) : null,
        scope: item.operation.scope,
        destination,
        sha256: item.desiredHash,
        mode: item.operation.mode,
        format: item.operation.format,
      });
    }
    const nextManifest = {
      version: MANIFEST_VERSION,
      generatedBy: `buildwithcli/${VERSION}`,
      generatedAt: new Date().toISOString(),
      entries: [...nextByDestination.values()].sort((left, right) => left.destination.localeCompare(right.destination)),
    };

    manifestTemp = await writeFileAtomic(
      manifestPath,
      Buffer.from(`${JSON.stringify(nextManifest, null, 2)}\n`),
      0o644,
    );
    const currentManifestState = await hashExistingFile(manifestPath);
    if (!sameFileState(currentManifestState, manifestSnapshot.state)) {
      throw new BuildWithCliError(`Manifest changed before commit: ${manifestPath}`, {
        code: 'MANIFEST_CHANGED',
        exitCode: 2,
      });
    }
    oldManifestBackup = currentManifestState
      ? `${manifestPath}.buildwithcli-backup-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
      : null;
    if (oldManifestBackup) await fsp.rename(manifestPath, oldManifestBackup);
    await fsp.rename(manifestTemp, manifestPath);
    manifestTemp = null;
    manifestCommitted = true;

    // Cleanup failures must not roll back an already valid destination + manifest state.
    if (oldManifestBackup) await fsp.rm(oldManifestBackup, { force: true }).catch(() => {});
    oldManifestBackup = null;
    for (const item of committed) {
      if (item.backup) await fsp.rm(item.backup, { force: true }).catch(() => {});
    }
    return { ...preflight, manifestPath, manifest: nextManifest, dryRun: false };
  } catch (error) {
    if (manifestTemp) await fsp.rm(manifestTemp, { force: true }).catch(() => {});
    if (manifestCommitted) {
      await fsp.rm(manifestPath, { force: true }).catch(() => {});
      if (oldManifestBackup) await fsp.rename(oldManifestBackup, manifestPath).catch(() => {});
    } else if (oldManifestBackup) {
      await fsp.rename(oldManifestBackup, manifestPath).catch(() => {});
    }
    for (const item of [...committed].reverse()) {
      await fsp.rm(item.operation.destination, { force: true }).catch(() => {});
      if (item.backup) await fsp.rename(item.backup, item.operation.destination).catch(() => {});
    }
    for (const item of staged) if (item.temp) await fsp.rm(item.temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function uninstallProjection({
  manifestPath,
  manifestBoundaryRoot = null,
  allowedRootsByTarget = null,
  targetIds = [],
  selectors = [],
  force = false,
  dryRun = false,
}) {
  const resolvedManifestPath = path.resolve(manifestPath);
  await assertNoSymlinkTraversal(
    path.dirname(resolvedManifestPath),
    resolvedManifestPath,
    manifestBoundaryRoot,
  );
  const manifestSnapshot = await readManifestSnapshot(
    resolvedManifestPath,
    manifestBoundaryRoot,
  );
  const manifest = manifestSnapshot.manifest;
  const targetSet = targetIds.length ? new Set(targetIds) : null;
  const selected = manifest.entries.filter((entry) => {
    if (targetSet && !(entry.targetIds || []).some((targetId) => targetSet.has(targetId))) return false;
    if (!selectors.length) return true;
    const pseudo = { kind: entry.sourceKind, name: entry.sourceName };
    return selectors.some((selector) => selectorMatches(pseudo, selector));
  });

  const statuses = [];
  const conflicts = [];
  for (const entry of selected) {
    const ownersToValidate = targetSet
      ? entry.targetIds.filter((targetId) => targetSet.has(targetId))
      : entry.targetIds;
    validateManifestTargetRoots(entry, allowedRootsByTarget, resolvedManifestPath, ownersToValidate);
    await assertNoSymlinkTraversal(entry.root, entry.destination, entry.boundaryRoot || null);
    const remainingTargetIds = targetSet
      ? (entry.targetIds || []).filter((targetId) => !targetSet.has(targetId))
      : [];
    if (remainingTargetIds.length > 0) {
      statuses.push({ entry, status: 'detach', remainingTargetIds });
      continue;
    }

    const existing = await hashExistingFile(entry.destination);
    if (!existing) statuses.push({ entry, status: 'missing', remainingTargetIds: [], previous: null });
    else if (force || (existing.hash === entry.sha256 && existing.mode === entry.mode)) {
      statuses.push({ entry, status: 'remove', remainingTargetIds: [], previous: existing });
    } else {
      statuses.push({ entry, status: 'conflict', remainingTargetIds: [], previous: existing });
      conflicts.push(entry);
    }
  }
  if (conflicts.length) {
    throw new BuildWithCliError(
      `Refusing to remove ${conflicts.length} locally modified file(s). Re-run with --force to delete them.`,
      { code: 'UNINSTALL_CONFLICT', exitCode: 2, details: conflicts },
    );
  }
  if (dryRun || selected.length === 0) {
    return { statuses, dryRun, manifestPath: resolvedManifestPath, manifest };
  }

  const moved = [];
  let manifestTemp = null;
  let oldManifestBackup = null;
  let manifestCommitted = false;
  try {
    for (const item of statuses) {
      if (item.status !== 'remove') continue;
      await assertNoSymlinkTraversal(item.entry.root, item.entry.destination, item.entry.boundaryRoot || null);
      const current = await hashExistingFile(item.entry.destination);
      if (!sameFileState(current, item.previous)) {
        throw new BuildWithCliError(`Destination changed after uninstall preflight: ${item.entry.destination}`, {
          code: 'DESTINATION_CHANGED',
          exitCode: 2,
        });
      }
      const trash = `${item.entry.destination}.buildwithcli-remove-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      await fsp.rename(item.entry.destination, trash);
      moved.push({ ...item, trash });
    }

    const statusByDestination = new Map(
      statuses.map((item) => [path.resolve(item.entry.destination), item]),
    );
    const nextEntries = [];
    for (const entry of manifest.entries) {
      const status = statusByDestination.get(path.resolve(entry.destination));
      if (!status) {
        nextEntries.push(entry);
      } else if (status.status === 'detach') {
        nextEntries.push({ ...entry, targetIds: status.remainingTargetIds });
      }
      // remove and missing entries are intentionally dropped from the manifest.
    }
    const nextManifest = {
      ...manifest,
      generatedBy: `buildwithcli/${VERSION}`,
      generatedAt: new Date().toISOString(),
      entries: nextEntries.sort((left, right) => left.destination.localeCompare(right.destination)),
    };

    manifestTemp = await writeFileAtomic(
      resolvedManifestPath,
      Buffer.from(`${JSON.stringify(nextManifest, null, 2)}\n`),
      0o644,
    );
    const currentManifestState = await hashExistingFile(resolvedManifestPath);
    if (!sameFileState(currentManifestState, manifestSnapshot.state)) {
      throw new BuildWithCliError(`Manifest changed before uninstall commit: ${resolvedManifestPath}`, {
        code: 'MANIFEST_CHANGED',
        exitCode: 2,
      });
    }
    oldManifestBackup = currentManifestState
      ? `${resolvedManifestPath}.buildwithcli-backup-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
      : null;
    if (oldManifestBackup) await fsp.rename(resolvedManifestPath, oldManifestBackup);
    await fsp.rename(manifestTemp, resolvedManifestPath);
    manifestTemp = null;
    manifestCommitted = true;

    if (oldManifestBackup) await fsp.rm(oldManifestBackup, { force: true }).catch(() => {});
    oldManifestBackup = null;
    for (const item of moved) {
      await fsp.rm(item.trash, { force: true }).catch(() => {});
      await removeEmptyParents(path.dirname(item.entry.destination), item.entry.root);
    }
    return {
      statuses,
      dryRun: false,
      manifestPath: resolvedManifestPath,
      manifest: nextManifest,
    };
  } catch (error) {
    if (manifestTemp) await fsp.rm(manifestTemp, { force: true }).catch(() => {});
    if (manifestCommitted) {
      await fsp.rm(resolvedManifestPath, { force: true }).catch(() => {});
      if (oldManifestBackup) await fsp.rename(oldManifestBackup, resolvedManifestPath).catch(() => {});
    } else if (oldManifestBackup) {
      await fsp.rename(oldManifestBackup, resolvedManifestPath).catch(() => {});
    }
    for (const item of [...moved].reverse()) {
      await fsp.rename(item.trash, item.entry.destination).catch(() => {});
    }
    throw error;
  }
}

async function removeEmptyParents(start, stop) {
  let current = path.resolve(start);
  const resolvedStop = path.resolve(stop);
  while (current !== resolvedStop && isPathInside(resolvedStop, current)) {
    const entries = await fsp.readdir(current).catch(() => null);
    if (!entries || entries.length) return;
    await fsp.rmdir(current).catch(() => {});
    current = path.dirname(current);
  }
}

function nearestGitRoot(start) {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

function splitOptionValues(value) {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => String(entry).split(',')).map((entry) => entry.trim()).filter(Boolean);
}

function countByKind(resources) {
  const counts = { agent: 0, command: 0, skill: 0 };
  for (const resource of resources) counts[resource.kind] += 1;
  return counts;
}

module.exports = {
  applyProjection, uninstallProjection, removeEmptyParents, nearestGitRoot,
  splitOptionValues, countByKind,
};
