'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { scanCatalog } = require('./catalog');
const { applyFileMap } = require('./safe-fs');
const { BUILTIN_ADAPTERS, custom, getAdapter, listTargets } = require('./adapters');

const DEFAULT_TARGETS = ['opencode', 'hermes', 'codex', 'copilot', 'claude', 'universal'];

async function readDescriptor(filePath) {
  if (!filePath) throw new Error('--config is required for target custom');
  const absolute = path.resolve(filePath);
  const data = JSON.parse(await fs.readFile(absolute, 'utf8'));
  return custom.validateDescriptor(data);
}

function hookOptions(options = {}) {
  const mode = options.hooks || 'disabled';
  if (!['disabled', 'trusted'].includes(mode)) throw new Error(`Invalid hooks mode: ${mode}`);
  if (mode === 'trusted' && options.trustHooks !== true) {
    throw new Error('Executable hook compilation requires both --hooks trusted and --trust-hooks. Review source commands first.');
  }
  return { includeHooks: mode === 'trusted' && options.trustHooks === true };
}

async function renderTarget(catalog, target, options = {}) {
  const hooks = hookOptions(options);
  if (target === 'custom') {
    const descriptor = options.descriptor || await readDescriptor(options.config);
    return custom.render(catalog, { ...options, ...hooks, descriptor });
  }
  const module = getAdapter(target);
  return module.render(catalog, { ...options, ...hooks });
}

function summaryCatalog(catalog) {
  return {
    schemaVersion: catalog.schemaVersion,
    source: catalog.sourceLabel,
    profile: catalog.profile,
    counts: catalog.counts,
    warnings: catalog.warnings,
    errors: catalog.errors,
    skills: catalog.skills.map(({ name, description, sourcePath }) => ({ name, description, sourcePath })),
    agents: catalog.agents.map(({ name, description, sourcePath }) => ({ name, description, sourcePath })),
    commands: catalog.commands.map(({ name, description, sourcePath }) => ({ name, description, sourcePath })),
    hooks: catalog.hooks.map(({ name, event, matcher, sourcePath }) => ({ name, event, matcher, sourcePath })),
    mcps: catalog.mcps.map(({ name, description, command, args, url, sourcePath }) => ({ name, description, command, args, url, sourcePath })),
  };
}

async function scan(source, options = {}) {
  return scanCatalog(source, {
    profile: options.profile,
    include: options.include,
    exclude: options.exclude,
    strict: options.strict,
    sourceLabel: options.sourceLabel,
    maxFileBytes: options.maxFileBytes,
    maxSkillBytes: options.maxSkillBytes,
    maxSkillFiles: options.maxSkillFiles,
    maxFiles: options.maxFiles,
    maxScanBytes: options.maxScanBytes,
    maxDepth: options.maxDepth,
  });
}

async function compile(options = {}) {
  const source = path.resolve(options.source || process.cwd());
  const target = options.target || 'universal';
  const catalog = options.catalog || await scan(source, options);
  if (options.strict && catalog.errors.length) throw new Error(`Catalog scan reported ${catalog.errors.length} errors`);
  const targetIds = target === 'all' ? DEFAULT_TARGETS : [target];
  if (target === 'all' && options.config) throw new Error('Custom target config cannot be combined with --target all');
  const outputRoot = path.resolve(options.out || options.dest || path.join(source, '.buildwithcli', 'dist'));
  const results = [];

  for (const targetId of targetIds) {
    const rendered = await renderTarget(catalog, targetId, options);
    const destination = targetIds.length > 1 ? path.join(outputRoot, targetId) : outputRoot;
    const applied = await applyFileMap(destination, rendered.files, {
      target: targetId,
      source: catalog.sourceLabel,
      dryRun: options.dryRun,
      clean: options.clean,
      force: options.force,
      replaceUnmanaged: options.replaceUnmanaged,
      forceManifest: options.forceManifest,
      stamp: options.stamp,
      maxOutputFiles: options.maxOutputFiles,
      maxOutputBytes: options.maxOutputBytes,
    });
    results.push({
      target: targetId === 'custom' ? rendered.report.target : targetId,
      destination,
      report: rendered.report,
      operations: applied.operations,
      manifest: applied.manifest,
    });
  }
  return { catalog: summaryCatalog(catalog), results };
}

async function validate(options = {}) {
  const source = path.resolve(options.source || process.cwd());
  const catalog = await scan(source, { ...options, strict: true });
  const rendered = [];
  for (const target of DEFAULT_TARGETS) {
    const result = await renderTarget(catalog, target, { ...options, hooks: 'disabled', trustHooks: false });
    rendered.push({ target, files: result.files.size, report: result.report });
  }
  if (options.config) {
    const descriptor = await readDescriptor(options.config);
    const result = await custom.render(catalog, { ...options, includeHooks: false, descriptor });
    rendered.push({ target: descriptor.id, files: result.files.size, report: result.report });
  }
  return { catalog: summaryCatalog(catalog), rendered };
}

module.exports = {
  DEFAULT_TARGETS,
  compile,
  hookOptions,
  listTargets,
  readDescriptor,
  renderTarget,
  scan,
  summaryCatalog,
  validate,
};
