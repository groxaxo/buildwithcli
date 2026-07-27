'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeServer, scanCatalog } = require('../lib/portable/catalog');
const { sourceTools } = require('../lib/portable/normalize');
const { makeFixture, removeFixture } = require('./helpers');

test('curated scanner builds a bounded canonical catalog without duplicate hook extraction', async (t) => {
  const root = await makeFixture();
  t.after(() => removeFixture(root));
  const catalog = await scanCatalog(root, { profile: 'curated', strict: true });
  assert.deepEqual(catalog.counts, {
    skills: 1,
    agents: 3,
    commands: 1,
    hookTemplates: 1,
    executableHooks: 2,
    mcps: 2,
  });
  assert.equal(catalog.errors.length, 0);
  assert.deepEqual(catalog.skills[0].bundle.map((entry) => entry.relative), ['SKILL.md', 'references/checklist.md', 'scripts/run.sh']);
  assert.equal(catalog.skills[0].bundle.find((entry) => entry.relative === 'scripts/run.sh').mode, 0o755);

  const inherited = sourceTools(catalog.agents.find((agent) => agent.name === 'inherit'));
  assert.equal(inherited.specified, false);
  const noTools = sourceTools(catalog.agents.find((agent) => agent.name === 'no-tools'));
  assert.equal(noTools.specified, true);
  assert.deepEqual(noTools.capabilities, []);
});

test('all-profile scanner parses JSONC config safely', async (t) => {
  const root = await makeFixture();
  t.after(() => removeFixture(root));
  const catalog = await scanCatalog(root, { profile: 'all', strict: true });
  const jsonc = catalog.mcps.find((server) => server.name === 'jsonc-server');
  assert.ok(jsonc);
  assert.equal(jsonc.toolTimeoutSec, 5);
  assert.equal(catalog.errors.length, 0);
});

test('MCP timeout normalization distinguishes millisecond-native and second-native source schemas', () => {
  assert.equal(normalizeServer('opencode', { type: 'local', command: ['node'], timeout: 5000 }, 'opencode.json').toolTimeoutSec, 5);
  assert.equal(normalizeServer('copilot', { type: 'local', command: 'node', tools: ['*'], timeout: 7000 }, '.mcp.json').toolTimeoutSec, 7);
  assert.equal(normalizeServer('portable', { command: 'node', timeout: 20 }, '.mcp.json').toolTimeoutSec, 20);
  assert.equal(normalizeServer('explicit', { command: 'node', tool_timeout_ms: 2500 }, '.mcp.json').toolTimeoutSec, 2.5);
});
