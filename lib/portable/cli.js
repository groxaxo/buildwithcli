'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { compile, listTargets, scan, summaryCatalog, validate } = require('./compiler');
const { doctor } = require('./doctor');
const { stableStringify } = require('./util');

const HELP = `BuildWithCLI — compile one agent catalog for multiple CLI hosts\n\nUsage:\n  buildwithcli targets [--json]\n  buildwithcli scan [--source DIR] [--profile curated|all] [--strict] [--json]\n  buildwithcli validate [--source DIR] [--profile curated|all] [--config FILE] [--json]\n  buildwithcli doctor [--source DIR] [--json]\n  buildwithcli compile --target TARGET [--source DIR] [--out DIR] [options]\n  buildwithcli install --target TARGET --dest DIR [--source DIR] [options]\n\nTargets:\n  opencode, hermes, codex, copilot, claude, universal, custom, all\n\nCompilation options:\n  --profile curated|all       Curated aggregate bundles or every discoverable component\n  --include GLOB              Include source path glob (repeatable)\n  --exclude GLOB              Exclude source path glob (repeatable)\n  --hooks disabled|trusted    Executable hooks default to disabled\n  --trust-hooks               Required in addition to --hooks trusted\n  --config FILE               Declarative descriptor for --target custom\n  --dry-run                   Validate and show operations without writing\n  --clean                     Remove obsolete files owned by the prior manifest\n  --force                     Replace locally modified managed files\n  --replace-unmanaged         Replace destination files not owned by BuildWithCLI\n  --strict                    Abort on source scan errors\n  --stamp                     Include non-reproducible current timestamps\n  --json                      Emit machine-readable JSON\n`;

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() || 'help';
  const options = { include: [], exclude: [] };
  const boolean = new Set(['strict', 'dry-run', 'clean', 'force', 'replace-unmanaged', 'force-manifest', 'trust-hooks', 'json', 'stamp', 'help']);
  while (args.length) {
    const token = args.shift();
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const equals = token.indexOf('=');
    const rawKey = token.slice(2, equals >= 0 ? equals : undefined);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (boolean.has(rawKey)) {
      options[key] = true;
      continue;
    }
    const value = equals >= 0 ? token.slice(equals + 1) : args.shift();
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for --${rawKey}`);
    if (key === 'include' || key === 'exclude') options[key].push(value);
    else options[key] = value;
  }
  return { command, options };
}

async function loadDefaults(source, options) {
  const configPath = options.settings || path.join(source, 'buildwithcli.config.json');
  try {
    const defaults = JSON.parse(await fs.readFile(configPath, 'utf8'));
    return {
      ...defaults,
      ...options,
      include: options.include.length ? options.include : defaults.include || [],
      exclude: options.exclude.length ? options.exclude : defaults.exclude || [],
    };
  } catch (error) {
    if (error.code === 'ENOENT') return options;
    throw new Error(`Cannot read ${configPath}: ${error.message}`);
  }
}

function humanTargets(targets) {
  const lines = ['BuildWithCLI targets:', ''];
  for (const target of targets) {
    const native = Object.entries(target.capabilities).filter(([, value]) => value.native).map(([name]) => name).join(', ');
    lines.push(`- ${target.id.padEnd(10)} ${target.displayName} — native: ${native || 'none'}`);
  }
  lines.push('- custom     Declarative Agent Skills adapter for additional CLI hosts');
  return lines.join('\n') + '\n';
}

function humanDoctor(result) {
  const lines = [`BuildWithCLI doctor: ${result.ok ? 'PASS' : 'FAIL'}`, '', `Source: ${result.source}`, '', 'Repository checks:'];
  for (const check of result.checks) lines.push(`  ${check.status === 'ok' ? '✓' : check.status === 'warning' ? '!' : '✗'} ${check.id || check.path}${check.version ? ` ${check.version}` : ''}${check.message ? ` — ${check.message}` : ''}`);
  lines.push('', 'Detected agent CLIs:');
  for (const binary of result.binaries) lines.push(`  ${binary.status === 'ok' ? '✓' : binary.found ? '!' : '·'} ${binary.id}${binary.version ? ` — ${binary.version}` : ` — ${binary.status}`}`);
  return lines.join('\n') + '\n';
}

function operationSummary(result) {
  const lines = [];
  for (const target of result.results) {
    const counts = {};
    for (const operation of target.operations) counts[operation.action] = (counts[operation.action] || 0) + 1;
    lines.push(`${target.target}: ${target.destination}`);
    lines.push(`  ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(' ') || 'no operations'}`);
    lines.push(`  warnings=${target.report.warnings.length} degradations=${target.report.degradations.length} scan-errors=${target.report.errors.length}`);
  }
  return lines.join('\n') + '\n';
}

async function run(argv = process.argv.slice(2), io = console) {
  const { command, options: rawOptions } = parseArgs(argv);
  if (command === 'help' || rawOptions.help) {
    io.log(HELP.trimEnd());
    return 0;
  }
  const source = path.resolve(rawOptions.source || process.cwd());
  const options = await loadDefaults(source, { ...rawOptions, source });

  if (command === 'targets') {
    const targets = listTargets();
    io.log(options.json ? stableStringify(targets).trimEnd() : humanTargets(targets).trimEnd());
    return 0;
  }
  if (command === 'doctor') {
    const result = doctor(options);
    io.log(options.json ? stableStringify(result).trimEnd() : humanDoctor(result).trimEnd());
    return result.ok ? 0 : 1;
  }
  if (command === 'scan') {
    const result = summaryCatalog(await scan(source, options));
    if (options.json) io.log(stableStringify(result).trimEnd());
    else io.log(`BuildWithCLI scan: ${Object.entries(result.counts).map(([key, value]) => `${key}=${value}`).join(' ')}\nwarnings=${result.warnings.length} errors=${result.errors.length}`);
    return result.errors.length && options.strict ? 1 : 0;
  }
  if (command === 'validate') {
    const result = await validate(options);
    if (options.json) io.log(stableStringify(result).trimEnd());
    else io.log(`BuildWithCLI validation: PASS\n${result.rendered.map((item) => `${item.target}: ${item.files} files`).join('\n')}`);
    return 0;
  }
  if (command === 'compile' || command === 'install') {
    if (!options.target) throw new Error('--target is required');
    if (command === 'install' && !options.dest) throw new Error('--dest is required for install');
    if (command === 'compile' && !options.out) options.out = path.join(source, '.buildwithcli', 'dist');
    const result = await compile(options);
    io.log(options.json ? stableStringify(result).trimEnd() : operationSummary(result).trimEnd());
    return 0;
  }
  throw new Error(`Unknown command '${command}'.\n\n${HELP}`);
}

async function main(argv = process.argv.slice(2)) {
  try {
    const code = await run(argv, console);
    process.exitCode = code;
  } catch (error) {
    console.error(`buildwithcli: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { HELP, humanDoctor, humanTargets, loadDefaults, main, operationSummary, parseArgs, run };
