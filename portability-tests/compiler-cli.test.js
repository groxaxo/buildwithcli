'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { compile, hookOptions, validate } = require('../lib/portable/compiler');
const { run } = require('../lib/portable/cli');
const { makeFixture, removeFixture } = require('./helpers');

test('hook trust requires two explicit flags', () => {
  assert.deepEqual(hookOptions({ hooks: 'disabled' }), { includeHooks: false });
  assert.throws(() => hookOptions({ hooks: 'trusted' }), /requires both/);
  assert.deepEqual(hookOptions({ hooks: 'trusted', trustHooks: true }), { includeHooks: true });
});

test('compiler emits every built-in target into isolated managed directories', async (t) => {
  const source = await makeFixture();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'buildwithcli-all-'));
  t.after(() => Promise.all([removeFixture(source), fs.rm(out, { recursive: true, force: true })]));
  const result = await compile({ source, target: 'all', out, profile: 'curated', strict: true });
  assert.equal(result.results.length, 6);
  for (const target of result.results) {
    await fs.access(path.join(target.destination, '.buildwithcli-manifest.json'));
    await fs.access(path.join(target.destination, 'PORTABILITY_REPORT.json'));
  }
  const validation = await validate({ source, profile: 'curated' });
  assert.equal(validation.rendered.length, 6);
});

test('custom descriptor adds a future CLI without code changes', async (t) => {
  const source = await makeFixture();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'buildwithcli-custom-'));
  const config = path.join(out, 'target.json');
  await fs.writeFile(config, JSON.stringify({
    id: 'future-cli',
    displayName: 'Future CLI',
    skillDir: '.future/skills',
    agentMode: 'both',
    agentDir: '.future/agents',
    commandMode: 'skill',
    instructionsPath: 'FUTURE.md',
    mcpPath: '.future/mcp.json',
  }));
  t.after(() => Promise.all([removeFixture(source), fs.rm(out, { recursive: true, force: true })]));
  const dest = path.join(out, 'compiled');
  const result = await compile({ source, target: 'custom', config, out: dest, profile: 'curated' });
  assert.equal(result.results[0].report.target, 'future-cli');
  await fs.access(path.join(dest, '.future/agents/reviewer.md'));
  await fs.access(path.join(dest, '.future/skills/command-fix/SKILL.md'));
});

test('CLI smoke test returns machine-readable scan output', async (t) => {
  const source = await makeFixture();
  t.after(() => removeFixture(source));
  const messages = [];
  const code = await run(['scan', '--source', source, '--profile', 'curated', '--json'], { log: (message) => messages.push(message) });
  assert.equal(code, 0);
  const parsed = JSON.parse(messages.join('\n'));
  assert.equal(parsed.counts.skills, 1);
});
