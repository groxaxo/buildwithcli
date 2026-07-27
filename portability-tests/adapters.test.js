'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { scanCatalog } = require('../lib/portable/catalog');
const adapters = require('../lib/portable/adapters');
const opencodeNative = require('../lib/portable/adapters/opencode');
const hermesNative = require('../lib/portable/adapters/hermes');
const { mapSnapshot, makeFixture, removeFixture } = require('./helpers');

async function catalogFixture(t) {
  const root = await makeFixture();
  t.after(() => removeFixture(root));
  return scanCatalog(root, { profile: 'curated', strict: true });
}

function text(files, name) {
  const value = files.get(name);
  assert.ok(value, `missing generated file ${name}`);
  return Buffer.isBuffer(value.content) ? value.content.toString('utf8') : String(value.content);
}

test('OpenCode permissions preserve exact source allow-lists without widening', async (t) => {
  const catalog = await catalogFixture(t);
  const rendered = await adapters.getAdapter('opencode').render(catalog, { includeHooks: false });
  const inherited = text(rendered.files, '.opencode/agents/inherit.md');
  const noTools = text(rendered.files, '.opencode/agents/no-tools.md');
  const reviewer = text(rendered.files, '.opencode/agents/reviewer.md');
  assert.doesNotMatch(inherited, /permission:/);
  assert.match(noTools, /"\*": deny|\*: deny/);
  assert.match(reviewer, /read: allow/);
  assert.match(reviewer, /grep: allow/);
  assert.doesNotMatch(reviewer, /(?:glob|list|lsp): allow/);
  assert.match(reviewer, /"\*": deny|\*: deny/);
});

test('OpenCode MCP environment references are translated to native env placeholders', async (t) => {
  const catalog = await catalogFixture(t);
  const rendered = await adapters.getAdapter('opencode').render(catalog, { includeHooks: false });
  const config = JSON.parse(text(rendered.files, 'opencode.json'));
  assert.equal(config.mcp.remoteapi.headers.Authorization, 'Bearer {env:MCP_TOKEN}');
  assert.equal(config.mcp.remoteapi.headers['X-Tenant'], '{env:TENANT_ID}');
  assert.deepEqual(config.mcp.localfs.command, ['npx', '-y', '@modelcontextprotocol/server-filesystem', '.']);
});

test('OpenCode hook matchers target native tool IDs and the runner bounds process trees and I/O', async (t) => {
  const catalog = await catalogFixture(t);
  const warnings = [];
  const prepared = opencodeNative.prepareHooks(catalog.hooks, warnings);
  assert.deepEqual(prepared.find((hook) => hook.event === 'tool.execute.before').patterns, ['bash']);
  assert.deepEqual(prepared.find((hook) => hook.event === 'tool.execute.after').patterns, ['edit', 'apply_patch', 'write']);
  assert.deepEqual(warnings, []);

  const rendered = await adapters.getAdapter('opencode').render(catalog, { includeHooks: true });
  const plugin = text(rendered.files, '.opencode/plugins/buildwithcli-hooks.js');
  assert.match(plugin, /detached: process\.platform !== "win32"/);
  assert.match(plugin, /process\.kill\(-child\.pid, signal\)/);
  assert.match(plugin, /let timer = null/);
  assert.match(plugin, /outputBytes \+= chunk\.length/);
  assert.doesNotMatch(plugin, /const timer = setTimeout/);
});

test('Hermes maps hook matchers to native tool IDs and omits deny-all agents', async (t) => {
  const catalog = await catalogFixture(t);
  const warnings = [];
  const prepared = hermesNative.prepareHooks(catalog.hooks, warnings);
  assert.deepEqual(prepared.find((hook) => hook.event === 'pre_tool_call').patterns, ['terminal']);
  assert.deepEqual(prepared.find((hook) => hook.event === 'post_tool_call').patterns, ['patch', 'write_file']);
  assert.deepEqual(warnings, []);

  const rendered = await adapters.getAdapter('hermes').render(catalog, { includeHooks: true });
  assert.equal(rendered.files.has('skills/agent-no-tools/SKILL.md'), false);
  assert.ok(rendered.files.has('unsupported/agents/no-tools.md'));
  assert.ok(rendered.report.warnings.some((item) => item.code === 'HERMES_AGENT_OMITTED_DENY_ALL'));
  assert.ok(rendered.report.warnings.some((item) => item.code === 'HERMES_AGENT_TOOL_POLICY_ADVISORY'));
  const plugin = text(rendered.files, '__init__.py');
  assert.match(plugin, /fnmatchcase\(\(value or ""\)\.lower\(\), \(pattern or ""\)\.lower\(\)\)/);
  assert.match(plugin, /signal\.SIGKILL if force else signal\.SIGTERM/);
  assert.match(plugin, /except \(BrokenPipeError, OSError\):/);
});

test('Universal and custom skill adapters document deny-all agents instead of widening them', async (t) => {
  const catalog = await catalogFixture(t);
  const universal = await adapters.getAdapter('universal').render(catalog, { includeHooks: false });
  assert.equal(universal.files.has('.agents/skills/agent-no-tools/SKILL.md'), false);
  assert.ok(universal.files.has('unsupported/agents/no-tools.md'));
  assert.match(text(universal.files, 'AGENTS.md'), /Explicit deny-all agents not compiled/);
  assert.ok(universal.report.degradations.some((item) => item.code === 'UNIVERSAL_DENY_ALL_AGENT_OMITTED'));

  const custom = await adapters.custom.render(catalog, {
    descriptor: { id: 'future-cli', displayName: 'Future CLI', agentMode: 'skill', commandMode: 'skill' },
  });
  assert.equal(custom.files.has('.agents/skills/agent-no-tools/SKILL.md'), false);
  assert.ok(custom.files.has('unsupported/agents/no-tools.md'));
  assert.ok(custom.report.warnings.some((item) => item.code === 'CUSTOM_AGENT_OMITTED_DENY_ALL'));
});

test('Custom native mode preserves source deny-all metadata but reports unverified semantics', async (t) => {
  const catalog = await catalogFixture(t);
  const custom = await adapters.custom.render(catalog, {
    descriptor: {
      id: 'native-future', displayName: 'Native Future', agentMode: 'native', commandMode: 'native',
      agentDir: '.future/agents', commandDir: '.future/commands',
    },
  });
  assert.match(text(custom.files, '.future/agents/no-tools.md'), /^tools: \[\]$/m);
  assert.ok(custom.report.warnings.some((item) => item.code === 'CUSTOM_NATIVE_SCHEMA_UNVERIFIED'));
});

test('Copilot permissions preserve exact source allow-lists without widening', async (t) => {
  const catalog = await catalogFixture(t);
  const rendered = await adapters.getAdapter('copilot').render(catalog, { includeHooks: false });
  const inherited = text(rendered.files, 'agents/inherit.agent.md');
  const noTools = text(rendered.files, 'agents/no-tools.agent.md');
  assert.doesNotMatch(inherited, /^tools:/m);
  assert.match(noTools, /^tools: \[\]$/m);

  const reviewer = text(rendered.files, 'agents/reviewer.agent.md');
  assert.match(reviewer, /- view/);
  assert.doesNotMatch(reviewer, /- glob(?:\n|$)/);
  assert.match(reviewer, /- grep/);
  assert.doesNotMatch(reviewer, /- read(?:\n|$)/);
  assert.doesNotMatch(reviewer, /- search(?:\n|$)/);
});

test('Codex omits deny-all agents and constrains read-only source roles without claiming exact tool fidelity', async (t) => {
  const catalog = await catalogFixture(t);
  const rendered = await adapters.getAdapter('codex').render(catalog, { includeHooks: false });

  assert.equal(rendered.files.has('.codex/agents/no-tools.toml'), false);
  assert.equal(rendered.files.has('agents/no-tools.toml'), false);
  assert.equal(rendered.files.has('.agents/skills/agent-no-tools/SKILL.md'), false);
  assert.equal(rendered.files.has('skills/agent-no-tools/SKILL.md'), false);
  assert.ok(rendered.files.has('unsupported/agents/no-tools.md'));

  const reviewer = text(rendered.files, '.codex/agents/reviewer.toml');
  assert.match(reviewer, /^sandbox_mode = "read-only"$/m);
  assert.match(reviewer, /Source tool policy \(hard behavioral constraint\): only use these source-equivalent capabilities: Read, Grep\./);
  assert.ok(rendered.report.warnings.some((item) => item.code === 'CODEX_AGENT_OMITTED_DENY_ALL'));
  assert.ok(rendered.report.warnings.some((item) => item.code === 'CODEX_AGENT_TOOL_POLICY_PARTIAL'));
  assert.ok(rendered.report.degradations.some((item) => item.code === 'CODEX_DENY_ALL_AGENT_OMITTED'));
});

test('Copilot emits current native command, hook, plugin, and MCP layouts', async (t) => {
  const catalog = await catalogFixture(t);
  const rendered = await adapters.getAdapter('copilot').render(catalog, { includeHooks: true });
  assert.ok(rendered.files.has('.claude/commands/fix.md'));
  assert.equal(rendered.files.has('.github/commands/fix.md'), false);

  const manifest = JSON.parse(text(rendered.files, 'plugin.json'));
  assert.equal(Object.prototype.hasOwnProperty.call(manifest, 'strict'), false);
  assert.equal(manifest.commands, 'commands/');

  const hooks = JSON.parse(text(rendered.files, 'hooks.json'));
  assert.ok(Array.isArray(hooks.hooks.PreToolUse));
  assert.equal(hooks.hooks.PreToolUse[0].matcher, 'Bash|execute');
  assert.equal(hooks.hooks.PostToolUse[0].matcher, '^(?:edit|apply_patch|create)$');
  assert.equal(hooks.hooks.PreToolUse[0].command, 'node -e "process.stdin.resume()"');
  assert.equal(hooks.hooks.preToolUse, undefined);

  const mcp = JSON.parse(text(rendered.files, '.mcp.json')).mcpServers;
  assert.deepEqual(mcp.localfs, {
    type: 'local',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    tools: ['*'],
    env: { MODE: 'safe' },
    timeout: 20000,
  });
  assert.equal(mcp.remoteapi.type, 'http');
  assert.deepEqual(mcp.remoteapi.tools, ['*']);
  assert.equal(mcp.remoteapi.headers.Authorization, 'Bearer ${MCP_TOKEN}');
  assert.equal(mcp.remoteapi.headers['X-Tenant'], '${TENANT_ID}');
  assert.equal(mcp.remoteapi.timeout, 7000);
});

test('all native adapters generate syntactically valid JSON, JavaScript, Python, and TOML', async (t) => {
  const catalog = await catalogFixture(t);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'buildwithcli-generated-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));

  const opencode = await adapters.getAdapter('opencode').render(catalog, { includeHooks: true });
  const esm = path.join(temp, 'hooks.mjs');
  await fs.writeFile(esm, text(opencode.files, '.opencode/plugins/buildwithcli-hooks.js'));
  assert.equal(spawnSync(process.execPath, ['--check', esm], { encoding: 'utf8' }).status, 0);
  assert.match(await fs.readFile(esm, 'utf8'), /resolve\(baseDirectory, hook\.cwd\)/);
  JSON.parse(text(opencode.files, 'opencode.json'));

  const hermes = await adapters.getAdapter('hermes').render(catalog, { includeHooks: true });
  const hermesRoot = path.join(temp, 'hermes');
  await fs.mkdir(hermesRoot);
  await fs.writeFile(path.join(hermesRoot, '__init__.py'), text(hermes.files, '__init__.py'));
  const py = spawnSync('python3', ['-m', 'py_compile', path.join(hermesRoot, '__init__.py')], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  assert.match(await fs.readFile(path.join(hermesRoot, '__init__.py'), 'utf8'), /base_cwd = os\.getcwd\(\)/);

  const codex = await adapters.getAdapter('codex').render(catalog, { includeHooks: true });
  const tomlFile = path.join(temp, 'config.toml');
  await fs.writeFile(tomlFile, text(codex.files, '.codex/config.toml'));
  const toml = spawnSync('python3', ['-c', 'import pathlib,tomllib,sys; tomllib.loads(pathlib.Path(sys.argv[1]).read_text())', tomlFile], { encoding: 'utf8' });
  assert.equal(toml.status, 0, toml.stderr);
  for (const [name, entry] of codex.files.entries()) {
    if (!name.startsWith('.codex/agents/') || !name.endsWith('.toml')) continue;
    const parsed = spawnSync('python3', ['-c', 'import sys,tomllib; tomllib.loads(sys.stdin.read())'], {
      encoding: 'utf8', input: String(entry.content),
    });
    assert.equal(parsed.status, 0, `${name}: ${parsed.stderr}`);
  }
  JSON.parse(text(codex.files, '.codex-plugin/plugin.json'));
  JSON.parse(text(codex.files, '.codex/hooks.json'));

  const copilot = await adapters.getAdapter('copilot').render(catalog, { includeHooks: true });
  JSON.parse(text(copilot.files, 'plugin.json'));
  JSON.parse(text(copilot.files, 'hooks.json'));
  JSON.parse(text(copilot.files, '.mcp.json'));

  const claude = await adapters.getAdapter('claude').render(catalog, { includeHooks: true });
  JSON.parse(text(claude.files, '.claude-plugin/plugin.json'));
  JSON.parse(text(claude.files, 'hooks/hooks.json'));
});

test('all target reports warn about literal MCP secrets without echoing secret values', async (t) => {
  const catalog = await catalogFixture(t);
  catalog.mcps.push({
    kind: 'mcp', name: 'unsafe', sourcePath: '.mcp.json', url: 'https://example.invalid/mcp',
    headers: { Authorization: 'Bearer top-secret-value' }, envHeaders: {}, env: {}, enabled: true,
  });
  const rendered = await adapters.getAdapter('universal').render(catalog, { includeHooks: false });
  const warning = rendered.report.warnings.find((item) => item.code === 'LITERAL_MCP_SECRET');
  assert.ok(warning);
  assert.doesNotMatch(warning.message, /top-secret-value/);
});

test('rendered outputs are reproducible when timestamps are not requested', async (t) => {
  const catalog = await catalogFixture(t);
  for (const target of ['opencode', 'hermes', 'codex', 'copilot', 'claude', 'universal']) {
    const adapter = adapters.getAdapter(target);
    const first = await adapter.render(catalog, { includeHooks: false });
    const second = await adapter.render(catalog, { includeHooks: false });
    assert.deepEqual(mapSnapshot(first.files), mapSnapshot(second.files), target);
    assert.equal(first.report.generatedAt, undefined);
  }
});
