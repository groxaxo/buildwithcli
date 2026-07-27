'use strict';

const path = require('node:path');
const { stringifyFrontmatter } = require('../frontmatter');
const { sourceTools } = require('../normalize');
const { assertValidName, stableStringify } = require('../util');
const { addConvertedSkills, addFile, addSkillBundle, finalize, mcpStandardConfig } = require('./common');

const MODES = new Set(['native', 'skill', 'both', 'omit']);

function validateDescriptor(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Custom target descriptor must be an object');
  const descriptor = {
    id: assertValidName(String(input.id || ''), 'custom target id'),
    displayName: String(input.displayName || input.id),
    skillDir: String(input.skillDir || '.agents/skills'),
    agentMode: String(input.agentMode || 'skill'),
    commandMode: String(input.commandMode || 'skill'),
    agentDir: input.agentDir ? String(input.agentDir) : null,
    commandDir: input.commandDir ? String(input.commandDir) : null,
    agentExtension: String(input.agentExtension || '.md'),
    commandExtension: String(input.commandExtension || '.md'),
    instructionsPath: String(input.instructionsPath || 'AGENTS.md'),
    mcpPath: input.mcpPath === false ? null : String(input.mcpPath || '.mcp.json'),
    mcpRootKey: String(input.mcpRootKey || 'mcpServers'),
  };
  if (!MODES.has(descriptor.agentMode)) throw new Error(`Invalid custom agentMode: ${descriptor.agentMode}`);
  if (!MODES.has(descriptor.commandMode)) throw new Error(`Invalid custom commandMode: ${descriptor.commandMode}`);
  if (['native', 'both'].includes(descriptor.agentMode) && !descriptor.agentDir) throw new Error('custom agentDir is required for native/both agentMode');
  if (['native', 'both'].includes(descriptor.commandMode) && !descriptor.commandDir) throw new Error('custom commandDir is required for native/both commandMode');
  for (const [key, value] of Object.entries(descriptor)) {
    if (!key.endsWith('Dir') && !key.endsWith('Path')) continue;
    if (value == null) continue;
    const posix = value.replace(/\\/g, '/');
    if (path.posix.isAbsolute(posix) || posix.split('/').includes('..')) throw new Error(`Unsafe custom ${key}: ${value}`);
  }
  return descriptor;
}

function adapterFor(descriptor) {
  return {
    id: descriptor.id,
    displayName: descriptor.displayName,
    capabilities: {
      skills: { native: true, strategy: `${descriptor.skillDir}/<name>/SKILL.md` },
      agents: { native: ['native', 'both'].includes(descriptor.agentMode), strategy: descriptor.agentMode },
      commands: { native: ['native', 'both'].includes(descriptor.commandMode), strategy: descriptor.commandMode },
      hooks: { native: false, strategy: 'documented only' },
      mcp: { native: Boolean(descriptor.mcpPath), strategy: descriptor.mcpPath || 'omitted' },
    },
  };
}

function instructionMarkdown(catalog, descriptor, omittedSkillAgents = []) {
  return [
    `# ${descriptor.displayName} BuildWithCLI catalog`,
    '',
    `Skills are installed under \`${descriptor.skillDir}\`.`,
    '',
    'Use the narrowest applicable skill. Preserve repository policy, review executable scripts before running them, and never infer hook semantics that the host does not document.',
    '',
    `Inventory: ${catalog.skills.length} skills, ${catalog.agents.length} agents, ${catalog.commands.length} commands, ${catalog.mcps.length} MCP servers.`,
    ...(omittedSkillAgents.length ? ['', `Safety omission: ${omittedSkillAgents.length} explicit deny-all agent(s) were not converted into executable skills.`] : []),
    '',
  ].join('\n');
}

function customMcp(catalog, descriptor) {
  const standard = mcpStandardConfig(catalog).mcpServers;
  return { [descriptor.mcpRootKey]: standard };
}

function omittedAgentMarkdown(entity, descriptor) {
  return [
    `# Omitted ${descriptor.displayName} converted skill: ${entity.name}`,
    '',
    `Source: \`${entity.sourcePath}\``,
    '',
    'This source agent declares an explicit empty tool allow-list. BuildWithCLI did not convert it into an executable skill because a declarative custom adapter cannot prove that this host enforces deny-all semantics for skills.',
    '',
    'A native source-preserving artifact may still be present when `agentMode` is `native` or `both`; its enforcement semantics must be reviewed against the target host.',
    '',
    '## Original instructions',
    '',
    entity.body || entity.description,
    '',
  ].join('\n');
}

async function render(catalog, options = {}) {
  const descriptor = validateDescriptor(options.descriptor);
  const targetAdapter = adapterFor(descriptor);
  const files = new Map();
  const warnings = [];
  const degradations = [];
  const skillAgents = [];
  const omittedSkillAgents = [];

  for (const entity of catalog.agents) {
    const tools = sourceTools(entity);
    if (tools.specified && tools.raw.length === 0) omittedSkillAgents.push(entity);
    else skillAgents.push(entity);
  }

  for (const skill of catalog.skills) addSkillBundle(files, skill, descriptor.skillDir, descriptor.id);
  if (['skill', 'both'].includes(descriptor.agentMode) || ['skill', 'both'].includes(descriptor.commandMode)) {
    addConvertedSkills(files, { ...catalog, agents: skillAgents }, descriptor.skillDir, descriptor.id, {
      warnings,
      agents: ['skill', 'both'].includes(descriptor.agentMode),
      commands: ['skill', 'both'].includes(descriptor.commandMode),
    });
  }
  if (['skill', 'both'].includes(descriptor.agentMode)) {
    for (const entity of omittedSkillAgents) {
      addFile(files, `unsupported/agents/${entity.name}.md`, omittedAgentMarkdown(entity, descriptor), entity.sourcePath);
      warnings.push({
        code: 'CUSTOM_AGENT_OMITTED_DENY_ALL',
        source: entity.sourcePath,
        message: 'Explicit deny-all agent was not converted into a skill because the custom descriptor cannot prove host enforcement.',
      });
    }
  }
  if (['native', 'both'].includes(descriptor.agentMode)) {
    for (const entity of catalog.agents) {
      addFile(files, path.posix.join(descriptor.agentDir, `${entity.name}${descriptor.agentExtension}`), stringifyFrontmatter({ ...entity.data, name: entity.name, description: entity.description }, entity.body), entity.sourcePath);
    }
    warnings.push({ code: 'CUSTOM_NATIVE_SCHEMA_UNVERIFIED', message: 'Native custom agent files preserve source frontmatter verbatim, but BuildWithCLI cannot verify that the target host recognizes or enforces those fields.' });
  }
  if (['native', 'both'].includes(descriptor.commandMode)) {
    for (const entity of catalog.commands) {
      addFile(files, path.posix.join(descriptor.commandDir, `${entity.name}${descriptor.commandExtension}`), stringifyFrontmatter({ ...entity.data, description: entity.description }, entity.body), entity.sourcePath);
    }
    warnings.push({ code: 'CUSTOM_NATIVE_SCHEMA_UNVERIFIED', message: 'Native custom command files preserve source frontmatter, but BuildWithCLI cannot verify the target command schema or dispatch semantics.' });
  }
  addFile(files, descriptor.instructionsPath, instructionMarkdown(catalog, descriptor, ['skill', 'both'].includes(descriptor.agentMode) ? omittedSkillAgents : []), 'generated:instructions');
  if (descriptor.mcpPath && catalog.mcps.length) addFile(files, descriptor.mcpPath, stableStringify(customMcp(catalog, descriptor)), 'generated:mcp');

  if (catalog.hooks.length) warnings.push({ code: 'HOOKS_DOCUMENTED_ONLY', message: 'Custom adapters never synthesize executable hooks. Add a reviewed native adapter when the target hook contract is known.' });
  if (['skill', 'both'].includes(descriptor.agentMode) && skillAgents.some((entity) => sourceTools(entity).specified)) warnings.push({
    code: 'CUSTOM_SKILL_TOOL_POLICY_ADVISORY',
    message: 'Converted agent skills retain source tool metadata, but enforcement is target-dependent and is not asserted by a declarative custom adapter.',
  });
  if (['skill', 'both'].includes(descriptor.agentMode)) degradations.push({ code: 'AGENTS_AS_SKILLS', message: 'Safely representable agents are compiled to skills by custom target policy.' });
  if (omittedSkillAgents.length && ['skill', 'both'].includes(descriptor.agentMode)) degradations.push({ code: 'CUSTOM_DENY_ALL_AGENT_OMITTED', message: `${omittedSkillAgents.length} explicit deny-all agent(s) were documented instead of widened into executable skills.` });
  if (['skill', 'both'].includes(descriptor.commandMode)) degradations.push({ code: 'COMMANDS_AS_SKILLS', message: 'Commands are compiled to skills by custom target policy.' });
  return finalize(files, descriptor.id, catalog, targetAdapter, warnings, degradations, options);
}

module.exports = { MODES, adapterFor, customMcp, omittedAgentMarkdown, render, validateDescriptor };
