'use strict';

const { sourceTools } = require('../normalize');
const { stableStringify } = require('../util');
const { addConvertedSkills, addFile, addSkillBundle, finalize, mcpStandardConfig } = require('./common');

const adapter = {
  id: 'universal',
  displayName: 'Universal Agent Skills',
  capabilities: {
    skills: { native: true, strategy: '.agents/skills using the Agent Skills open format' },
    agents: { native: false, strategy: 'safe agent-to-skill conversion plus AGENTS.md index' },
    commands: { native: false, strategy: 'command-to-skill conversion' },
    hooks: { native: false, strategy: 'documented only; executable translation is never guessed' },
    mcp: { native: true, strategy: '.mcp.json portable MCP descriptor' },
  },
};

function agentsMarkdown(catalog, executableAgents = catalog.agents, omittedAgents = []) {
  const lines = [
    '# BuildWithCLI portable agent catalog',
    '',
    'This repository contains provider-neutral Agent Skills under `.agents/skills/`. Hosts that support the Agent Skills format can discover them directly. Other agent CLIs can load this file as repository instructions and open the relevant `SKILL.md` on demand.',
    '',
    '## Operating rules',
    '',
    '- Select the narrowest matching skill for the task.',
    '- Treat declared tool lists as restrictions, not suggestions.',
    '- Do not execute generated hooks unless an operator has reviewed and trusted them for the current repository.',
    '- Preserve repository-local instructions and security policy over catalog defaults.',
    '',
    '## Original skills',
    '',
  ];
  if (!catalog.skills.length) lines.push('None.');
  else for (const entity of catalog.skills) lines.push(`- **${entity.name}** — ${entity.description}`);
  lines.push('', '## Specialist agents compiled as skills', '');
  if (!executableAgents.length) lines.push('None.');
  else for (const entity of executableAgents) lines.push(`- **agent-${entity.name}** — ${entity.description}`);
  lines.push('', '## Explicit deny-all agents not compiled', '');
  if (!omittedAgents.length) lines.push('None.');
  else for (const entity of omittedAgents) lines.push(`- **${entity.name}** — documented at \`unsupported/agents/${entity.name}.md\`; no executable skill was emitted.`);
  lines.push('', '## Commands compiled as skills', '');
  if (!catalog.commands.length) lines.push('None.');
  else for (const entity of catalog.commands) lines.push(`- **command-${entity.name}** — ${entity.description}`);
  return lines.join('\n') + '\n';
}

function omittedAgentMarkdown(entity) {
  return [
    `# Omitted universal agent: ${entity.name}`,
    '',
    `Source: \`${entity.sourcePath}\``,
    '',
    'This source agent declares an explicit empty tool allow-list. The provider-neutral Agent Skills format does not guarantee a host-enforced deny-all execution boundary, so BuildWithCLI did not emit an executable converted skill.',
    '',
    '## Original instructions',
    '',
    entity.body || entity.description,
    '',
  ].join('\n');
}

function hooksMarkdown(catalog) {
  const lines = [
    '# Hook migration notes',
    '',
    'Executable hooks were intentionally not emitted by the universal adapter. Hook lifecycle names, blocking semantics, payload schemas, and trust models differ materially between agent CLIs.',
    '',
    '| Source | Event | Matcher |',
    '|---|---|---|',
  ];
  for (const hook of catalog.hooks) lines.push(`| ${hook.sourcePath} | ${hook.event} | ${String(hook.matcher || '*').replace(/\|/g, '\\|')} |`);
  if (!catalog.hooks.length) lines.push('| — | — | — |');
  return lines.join('\n') + '\n';
}

async function render(catalog, options = {}) {
  const files = new Map();
  const warnings = [];
  const degradations = [];
  const executableAgents = [];
  const omittedAgents = [];
  for (const entity of catalog.agents) {
    const tools = sourceTools(entity);
    if (tools.specified && tools.raw.length === 0) omittedAgents.push(entity);
    else executableAgents.push(entity);
    if (tools.specified && tools.raw.length > 0) warnings.push({
      code: 'UNIVERSAL_AGENT_TOOL_POLICY_ADVISORY',
      source: entity.sourcePath,
      message: `The source tool restriction (${tools.raw.join(', ')}) is retained in skill metadata, but enforcement depends on the consuming host.`,
    });
  }

  for (const skill of catalog.skills) addSkillBundle(files, skill, '.agents/skills', 'universal');
  addConvertedSkills(files, { ...catalog, agents: executableAgents }, '.agents/skills', 'universal', { warnings });
  for (const entity of omittedAgents) {
    addFile(files, `unsupported/agents/${entity.name}.md`, omittedAgentMarkdown(entity), entity.sourcePath);
    warnings.push({
      code: 'UNIVERSAL_AGENT_OMITTED_DENY_ALL',
      source: entity.sourcePath,
      message: 'Explicit deny-all agent was documented but not emitted as an executable universal skill.',
    });
  }
  addFile(files, 'AGENTS.md', agentsMarkdown(catalog, executableAgents, omittedAgents), 'generated:index');
  addFile(files, 'HOOKS.md', hooksMarkdown(catalog), 'generated:hook-docs');
  if (catalog.mcps.length) addFile(files, '.mcp.json', stableStringify(mcpStandardConfig(catalog)), 'generated:mcp');
  addFile(files, 'buildwithcli.portable.json', stableStringify({
    schemaVersion: 1,
    format: 'agent-skills',
    skills: '.agents/skills',
    instructions: 'AGENTS.md',
    ...(catalog.mcps.length ? { mcpServers: '.mcp.json' } : {}),
    hooks: 'HOOKS.md',
  }), 'generated:manifest');

  if (executableAgents.length) degradations.push({ code: 'AGENTS_AS_SKILLS', message: 'The universal format has no common subagent role schema, so safely representable specialist prompts are exported as Agent Skills and indexed from AGENTS.md.' });
  if (omittedAgents.length) degradations.push({ code: 'UNIVERSAL_DENY_ALL_AGENT_OMITTED', message: `${omittedAgents.length} explicit deny-all agent(s) were documented instead of being widened into executable skills.` });
  if (catalog.commands.length) degradations.push({ code: 'COMMANDS_AS_SKILLS', message: 'The universal format has no common slash-command registry, so command workflows are exported as user-selectable Agent Skills.' });
  if (catalog.hooks.length) warnings.push({ code: 'HOOKS_DOCUMENTED_ONLY', message: `${catalog.hooks.length} executable hooks were documented but never emitted by the universal adapter.` });
  return finalize(files, 'universal', catalog, adapter, warnings, degradations, options);
}

module.exports = { adapter, agentsMarkdown, hooksMarkdown, omittedAgentMarkdown, render };
