'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { VERSION, BuildWithCliError, sha256 } = require('./base');
const { discoverCatalog, selectResources } = require('./catalog');
const {
  TARGETS, expandEnvironmentTemplate, loadTargetProfiles, findExecutable,
  resolveRequestedTargets, resolveFormatRoot,
} = (() => {
  const targets = require('./targets');
  return { TARGETS: require('./base').TARGETS, ...targets };
})();
const { buildProjectionPlan } = require('./render');
const { manifestPathFor, buildAllowedRootsByTarget } = require('./manifest');
const {
  applyProjection, uninstallProjection, nearestGitRoot, splitOptionValues,
  countByKind,
} = require('./transaction');

function targetTable(targets) {
  return Object.values(targets).map((target) => ({
    id: target.id,
    name: target.displayName,
    binaries: target.binaries.join(', ') || 'none',
    project: target.project
      ? Object.entries(target.project.formats).map(([kind, format]) => `${kind}:${format}`).join(', ')
      : 'unsupported',
    user: target.user
      ? Object.entries(target.user.formats).map(([kind, format]) => `${kind}:${format}`).join(', ')
      : 'unsupported',
  }));
}

function renderTextTable(rows, columns) {
  const widths = {};
  for (const column of columns) {
    widths[column.key] = Math.max(column.label.length, ...rows.map((row) => String(row[column.key] ?? '').length));
  }
  const line = columns.map((column) => column.label.padEnd(widths[column.key])).join('  ');
  const separator = columns.map((column) => '-'.repeat(widths[column.key])).join('  ');
  const body = rows.map((row) => columns.map((column) => String(row[column.key] ?? '').padEnd(widths[column.key])).join('  '));
  return [line, separator, ...body].join('\n');
}

function installationSummary(result) {
  const counts = {};
  for (const item of result.statuses) counts[item.status] = (counts[item.status] || 0) + 1;
  return counts;
}

function printHumanInstall(io, result, plan, options = {}) {
  const summary = installationSummary(result);
  const action = options.uninstall ? 'Uninstall' : result.dryRun ? 'Plan' : 'Install';
  if (options.uninstall) {
    io.stdout.write(`${action}: ${summary.remove || 0} remove, ${summary.detach || 0} detach, ${summary.missing || 0} already missing\n`);
  } else {
    io.stdout.write(`${action}: ${summary.create || 0} create, ${summary.update || 0} update, ${summary.noop || 0} unchanged\n`);
  }
  for (const item of result.statuses) {
    const operation = item.operation || item.entry;
    const destination = operation.destination;
    io.stdout.write(`  ${item.status.padEnd(8)} ${destination}\n`);
  }
  if (plan?.warnings?.length) {
    io.stdout.write('\nWarnings:\n');
    for (const warning of plan.warnings) io.stdout.write(`  - [${warning.target}] ${warning.resource}: ${warning.warning}\n`);
  }
  if (plan?.targetNotes?.length) {
    io.stdout.write('\nTarget notes:\n');
    for (const note of plan.targetNotes) io.stdout.write(`  - [${note.target}] ${note.note}\n`);
  }
  io.stdout.write(`\nManifest: ${result.manifestPath}\n`);
}

function helpText() {
  return `BuildWithCLI ${VERSION}\n\n` +
    'Project one canonical catalog into native formats for OpenCode, Hermes Agent, Codex CLI, Copilot CLI, Claude Code, and generic Agent Skills consumers.\n\n' +
    'Usage:\n' +
    '  buildwithcli targets [--json]\n' +
    '  buildwithcli list [selectors...] [--kind agent,command,skill] [--json]\n' +
    '  buildwithcli doctor [--target auto|all|TARGET] [--scope project|user] [--json]\n' +
    '  buildwithcli install [selectors...] [--target auto|all|TARGET] [--scope project|user]\n' +
    '  buildwithcli plan [selectors...] [install options]\n' +
    '  buildwithcli export [selectors...] --output DIR [--target all]\n' +
    '  buildwithcli uninstall [selectors...] [--target TARGET] [--scope project|user]\n\n' +
    'Selectors:\n' +
    '  *                    All resources (default)\n' +
    '  python-expert        Any resource with this name\n' +
    '  agent:python-*       Glob by kind and name\n' +
    '  command:commit       One command\n\n' +
    'Common options:\n' +
    '  --target VALUE       Repeat or comma-separate targets; auto installs to detected CLIs\n' +
    '  --scope VALUE        project (default) or user\n' +
    '  --project DIR        Project root (default: nearest Git root)\n' +
    '  --catalog DIR        Catalog root (default: repository containing this CLI)\n' +
    '  --profile FILE       Add a custom target profile JSON file (repeatable)\n' +
    '  --kind VALUE         Restrict resource kinds (repeat or comma-separate)\n' +
    '  --exclude SELECTOR   Exclude a selector (repeatable)\n' +
    '  --dry-run            Show changes without writing\n' +
    '  --force              Replace untracked/modified destinations\n' +
    '  --strict             Fail on conflicting duplicate catalog entries\n' +
    '  --json               Emit machine-readable JSON\n' +
    '  --help               Show help\n';
}

const CLI_OPTIONS = {
  target: { type: 'string', multiple: true },
  scope: { type: 'string' },
  project: { type: 'string' },
  catalog: { type: 'string' },
  profile: { type: 'string', multiple: true },
  kind: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
  output: { type: 'string' },
  'dry-run': { type: 'boolean' },
  force: { type: 'boolean' },
  strict: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  'skip-binary-check': { type: 'boolean' },
};

function jsonSafePlan(plan) {
  return {
    warnings: plan.warnings,
    targetNotes: plan.targetNotes,
    operations: plan.operations.map((operation) => ({
      targetIds: operation.targetIds,
      sourceKind: operation.sourceKind,
      sourceName: operation.sourceName,
      outputName: operation.outputName,
      sourcePath: operation.sourcePath,
      destination: operation.destination,
      mode: operation.mode,
      format: operation.format,
      sha256: sha256(operation.content),
    })),
  };
}

async function runDoctor({ catalog, targets, targetIds, scope, context, skipBinaryCheck }) {
  const detections = targetIds.map((targetId) => {
    const target = targets[targetId];
    const executables = target.binaries.map((binary) => ({ binary, path: skipBinaryCheck ? null : findExecutable(binary, context.environment) }));
    const roots = {};
    for (const kind of ['agent', 'command', 'skill']) {
      try {
        roots[kind] = resolveFormatRoot(target, scope, kind, context).root;
      } catch {
        roots[kind] = null;
      }
    }
    return {
      target: targetId,
      displayName: target.displayName,
      detected: target.binaries.length === 0 || executables.some((entry) => Boolean(entry.path)),
      executables,
      roots,
    };
  });

  const hermesExternal = [];
  if (scope === 'project' && targetIds.includes('hermes')) {
    const configPath = path.resolve(expandEnvironmentTemplate('${HERMES_HOME:-~/.hermes}/config.yaml', context.environment, context.home));
    const expected = path.join(context.projectRoot, '.agents', 'skills');
    const config = await fsp.readFile(configPath, 'utf8').catch(() => '');
    hermesExternal.push({ configPath, expected, configured: config.includes(expected) || config.includes('.agents/skills') });
  }

  return {
    ok: catalog.resources.length > 0,
    catalog: {
      root: catalog.root,
      counts: countByKind(catalog.resources),
      duplicateCopies: catalog.warnings.length,
      conflictingDuplicates: catalog.conflicts.length,
      unsupported: catalog.unsupported,
    },
    detections,
    hermesExternal,
  };
}

async function runCli(argv = process.argv.slice(2), io = {}) {
  const streams = {
    stdout: io.stdout || process.stdout,
    stderr: io.stderr || process.stderr,
  };
  const environment = io.environment || process.env;
  const home = io.home || os.homedir();
  const cwd = path.resolve(io.cwd || process.cwd());

  const knownCommands = new Set(['help', 'targets', 'list', 'doctor', 'install', 'plan', 'export', 'uninstall']);
  const firstArgument = argv[0];
  const explicitCommand = firstArgument && !firstArgument.startsWith('-') && knownCommands.has(firstArgument)
    ? firstArgument
    : null;
  const command = explicitCommand || (firstArgument && !firstArgument.startsWith('-') ? 'install' : 'help');
  const argsForParser = explicitCommand ? argv.slice(1) : argv;
  const parsed = parseArgs({ args: argsForParser, options: CLI_OPTIONS, allowPositionals: true, strict: true });

  if (parsed.values.version) {
    streams.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (parsed.values.help || command === 'help') {
    streams.stdout.write(helpText());
    return 0;
  }

  const catalogRoot = path.resolve(parsed.values.catalog || path.join(__dirname, '..'));
  const profileFiles = parsed.values.profile || [];
  const targets = await loadTargetProfiles(profileFiles);

  if (command === 'targets') {
    const rows = targetTable(targets);
    if (parsed.values.json) streams.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    else streams.stdout.write(`${renderTextTable(rows, [
      { key: 'id', label: 'TARGET' },
      { key: 'name', label: 'NAME' },
      { key: 'binaries', label: 'BINARIES' },
      { key: 'project', label: 'PROJECT FORMATS' },
      { key: 'user', label: 'USER FORMATS' },
    ])}\n`);
    return 0;
  }

  const catalog = await discoverCatalog(catalogRoot, { strict: parsed.values.strict });
  const kinds = splitOptionValues(parsed.values.kind);
  for (const kind of kinds) {
    if (!['agent', 'command', 'skill'].includes(kind)) {
      throw new BuildWithCliError(`Unknown resource kind '${kind}'`, { code: 'UNKNOWN_KIND' });
    }
  }
  const excludes = splitOptionValues(parsed.values.exclude);
  const resources = selectResources(catalog.resources, parsed.positionals, { kinds, exclude: excludes });

  if (command === 'list') {
    const rows = resources.map((resource) => ({
      kind: resource.kind,
      name: resource.name,
      description: resource.description,
      source: resource.sourcePath,
    }));
    if (parsed.values.json) streams.stdout.write(`${JSON.stringify({ counts: countByKind(resources), resources: rows }, null, 2)}\n`);
    else streams.stdout.write(`${renderTextTable(rows, [
      { key: 'kind', label: 'KIND' },
      { key: 'name', label: 'NAME' },
      { key: 'source', label: 'SOURCE' },
    ])}\n\n${resources.length} resource(s)\n`);
    return 0;
  }

  const scope = parsed.values.scope || 'project';
  if (!['project', 'user'].includes(scope)) {
    throw new BuildWithCliError(`Scope must be 'project' or 'user', got '${scope}'`, { code: 'INVALID_SCOPE' });
  }
  const projectRoot = path.resolve(parsed.values.project || nearestGitRoot(cwd));
  const context = { projectRoot, home, environment };
  const requestedTargets = parsed.values.target || [];
  const effectiveTargets = command === 'export' && requestedTargets.length === 0 ? ['all'] : requestedTargets;
  const targetIds = resolveRequestedTargets(effectiveTargets, targets, environment);

  if (command === 'doctor') {
    const doctor = await runDoctor({
      catalog,
      targets,
      targetIds,
      scope,
      context,
      skipBinaryCheck: parsed.values['skip-binary-check'],
    });
    if (parsed.values.json) streams.stdout.write(`${JSON.stringify(doctor, null, 2)}\n`);
    else {
      streams.stdout.write(`Catalog: ${doctor.catalog.root}\n`);
      streams.stdout.write(`Resources: ${doctor.catalog.counts.agent} agents, ${doctor.catalog.counts.command} commands, ${doctor.catalog.counts.skill} skills\n`);
      streams.stdout.write(`Duplicate copies: ${doctor.catalog.duplicateCopies}; conflicting duplicates: ${doctor.catalog.conflictingDuplicates}\n`);
      streams.stdout.write(`Not auto-projected: ${doctor.catalog.unsupported.hooks} hook files, ${doctor.catalog.unsupported.mcp} MCP files\n\n`);
      for (const detection of doctor.detections) {
        const executable = detection.executables.filter((entry) => entry.path).map((entry) => entry.path).join(', ');
        streams.stdout.write(`${detection.detected ? 'OK' : 'MISSING'} ${detection.displayName}${executable ? ` (${executable})` : ''}\n`);
        for (const [kind, root] of Object.entries(detection.roots)) if (root) streams.stdout.write(`  ${kind}: ${root}\n`);
      }
      for (const check of doctor.hermesExternal) {
        streams.stdout.write(`\n${check.configured ? 'OK' : 'ACTION'} Hermes external skill directory: ${check.expected}\n`);
        if (!check.configured) {
          streams.stdout.write(`  Add it under skills.external_dirs in ${check.configPath}\n`);
        }
      }
    }
    return doctor.ok ? 0 : 2;
  }

  if (command === 'uninstall') {
    const manifestPath = manifestPathFor(scope, context);
    const result = await uninstallProjection({
      manifestPath,
      manifestBoundaryRoot: scope === 'project' ? context.projectRoot : context.home,
      allowedRootsByTarget: buildAllowedRootsByTarget(targets, scope, context),
      targetIds: requestedTargets.length ? targetIds : [],
      selectors: parsed.positionals,
      force: parsed.values.force,
      dryRun: parsed.values['dry-run'],
    });
    if (parsed.values.json) streams.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else printHumanInstall(streams, result, null, { uninstall: true });
    return 0;
  }

  if (resources.length === 0) {
    throw new BuildWithCliError('No resources matched the supplied selectors.', {
      code: 'NO_MATCHES',
      exitCode: 2,
    });
  }

  if (command === 'export') {
    if (!parsed.values.output) {
      throw new BuildWithCliError('The export command requires --output DIR', { code: 'MISSING_OUTPUT' });
    }
    if (scope !== 'project') {
      throw new BuildWithCliError('The export command supports project scope only; use install --scope user for personal installation.', {
        code: 'INVALID_EXPORT_SCOPE',
      });
    }
    context.projectRoot = path.resolve(parsed.values.output);
  }

  const plan = await buildProjectionPlan({ resources, targetIds, targets, scope, context });
  const dryRun = command === 'plan' || Boolean(parsed.values['dry-run']);
  const manifestPath = manifestPathFor(scope, context);
  const result = await applyProjection(plan, {
    manifestPath,
    manifestBoundaryRoot: scope === 'project' ? context.projectRoot : context.home,
    dryRun,
    force: parsed.values.force,
  });

  if (parsed.values.json) {
    streams.stdout.write(`${JSON.stringify({
      targets: targetIds,
      scope,
      projectRoot: context.projectRoot,
      catalog: catalog.root,
      plan: jsonSafePlan(plan),
      result: {
        dryRun: result.dryRun,
        manifestPath: result.manifestPath,
        statuses: result.statuses.map((item) => ({
          status: item.status,
          destination: item.operation.destination,
          sourceKind: item.operation.sourceKind,
          sourceName: item.operation.sourceName,
          targetIds: item.operation.targetIds,
        })),
      },
    }, null, 2)}\n`);
  } else {
    printHumanInstall(streams, result, plan);
  }
  return 0;
}


module.exports = { runDoctor, runCli };
