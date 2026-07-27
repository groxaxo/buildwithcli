'use strict';

const { stringifyFrontmatter } = require('../frontmatter');
const { mapHookEvent } = require('../normalize');
const { stableStringify } = require('../util');
const { addFile, addSkillBundle, finalize, mcpStandardConfig } = require('./common');

const PLUGIN_NAME = 'buildwithcli-catalog';

const adapter = {
  id: 'claude',
  displayName: 'Claude Code',
  capabilities: {
    skills: { native: true, strategy: 'skills/<name>/SKILL.md' },
    agents: { native: true, strategy: 'agents/<name>.md' },
    commands: { native: true, strategy: 'commands/<name>.md' },
    hooks: { native: true, strategy: 'hooks/hooks.json (trusted opt-in)' },
    mcp: { native: true, strategy: '.mcp.json' },
  },
};

function renderAgent(entity) {
  return stringifyFrontmatter({ ...entity.data, name: entity.name, description: entity.description }, entity.body);
}

function renderCommand(entity) {
  return stringifyFrontmatter({ ...entity.data, description: entity.description }, entity.body);
}

function prepareHooks(hooks, warnings) {
  const output = {};
  for (const hook of hooks) {
    const event = mapHookEvent(hook.event, 'claude');
    if (!event) {
      warnings.push({ code: 'HOOK_EVENT_UNSUPPORTED', source: hook.sourcePath, message: `Claude Code has no mapping for ${hook.event}.` });
      continue;
    }
    const item = {
      type: 'command',
      command: hook.command,
      timeout: Math.min(3600, Math.max(1, Number(hook.timeoutSec || 30))),
      ...(hook.cwd ? { cwd: hook.cwd } : {}),
      ...(Object.keys(hook.env || {}).length ? { env: hook.env } : {}),
    };
    (output[event] ||= []).push({ matcher: String(hook.matcher || '*'), hooks: [item] });
  }
  return { hooks: output };
}

function pluginManifest({ includeHooks, includeMcp }) {
  return {
    name: PLUGIN_NAME,
    version: '1.0.0',
    description: 'BuildWithCLI portable catalog for Claude Code',
    author: { name: 'BuildWithCLI Community', url: 'https://github.com/groxaxo/buildwithcli' },
    homepage: 'https://github.com/groxaxo/buildwithcli',
    repository: 'https://github.com/groxaxo/buildwithcli',
    license: 'MIT',
    keywords: ['claude-code', 'agents', 'skills', 'commands', 'mcp'],
    ...(includeHooks ? { hooks: './hooks/hooks.json' } : {}),
    ...(includeMcp ? { mcpServers: './.mcp.json' } : {}),
  };
}

async function render(catalog, options = {}) {
  const files = new Map();
  const warnings = [];
  const degradations = [];
  for (const skill of catalog.skills) addSkillBundle(files, skill, 'skills', 'claude');
  for (const agent of catalog.agents) addFile(files, `agents/${agent.name}.md`, renderAgent(agent), agent.sourcePath);
  for (const command of catalog.commands) addFile(files, `commands/${command.name}.md`, renderCommand(command), command.sourcePath);

  let hooks = null;
  if (options.includeHooks) {
    hooks = prepareHooks(catalog.hooks, warnings);
    if (!Object.keys(hooks.hooks).length) hooks = null;
  } else if (catalog.hooks.length) {
    warnings.push({ code: 'HOOKS_DISABLED', message: `${catalog.hooks.length} executable hooks were not emitted; rerun with --hooks trusted --trust-hooks after review.` });
  }
  if (hooks) addFile(files, 'hooks/hooks.json', stableStringify(hooks), 'generated:hooks');
  if (catalog.mcps.length) addFile(files, '.mcp.json', stableStringify(mcpStandardConfig(catalog)), 'generated:mcp');
  addFile(files, '.claude-plugin/plugin.json', stableStringify(pluginManifest({ includeHooks: Boolean(hooks), includeMcp: catalog.mcps.length > 0 })), 'generated:manifest');
  return finalize(files, 'claude', catalog, adapter, warnings, degradations, options);
}

module.exports = { PLUGIN_NAME, adapter, pluginManifest, prepareHooks, render, renderAgent, renderCommand };
