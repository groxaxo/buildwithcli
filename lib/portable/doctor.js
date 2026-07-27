'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI_PROBES = [
  { id: 'opencode', command: 'opencode', args: ['--version'] },
  { id: 'hermes', command: 'hermes', args: ['--version'] },
  { id: 'codex', command: 'codex', args: ['--version'] },
  { id: 'copilot', command: 'copilot', args: ['--version'] },
  { id: 'claude', command: 'claude', args: ['--version'] },
  { id: 'gemini', command: 'gemini', args: ['--version'] },
  { id: 'aider', command: 'aider', args: ['--version'] },
];

function probeBinary(probe) {
  const result = spawnSync(probe.command, probe.args, {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error?.code === 'ENOENT') return { id: probe.id, found: false, status: 'not-installed' };
  if (result.error) return { id: probe.id, found: true, status: 'error', message: result.error.message };
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim().split('\n')[0].slice(0, 300);
  return { id: probe.id, found: true, status: result.status === 0 ? 'ok' : 'error', version: output || null, exitCode: result.status };
}

function pathCheck(source, relative, required = false) {
  const absolute = path.join(source, relative);
  const exists = fs.existsSync(absolute);
  return { path: relative, exists, required, status: exists ? 'ok' : required ? 'error' : 'warning' };
}

function doctor(options = {}) {
  const source = path.resolve(options.source || process.cwd());
  const major = Number(process.versions.node.split('.')[0]);
  const checks = [
    { id: 'node', status: major >= 20 ? 'ok' : 'error', version: process.version, message: major >= 20 ? 'Node runtime is supported.' : 'Node 20 or newer is required.' },
    pathCheck(source, 'package.json', true),
    pathCheck(source, 'plugins/all-skills/skills'),
    pathCheck(source, 'plugins/all-agents/agents'),
    pathCheck(source, 'plugins/all-commands/commands'),
    pathCheck(source, 'plugins/all-hooks/hooks'),
  ];
  const binaries = CLI_PROBES.map(probeBinary);
  const ok = checks.every((item) => item.status !== 'error');
  return { source, ok, checks, binaries };
}

module.exports = { CLI_PROBES, doctor, probeBinary };
