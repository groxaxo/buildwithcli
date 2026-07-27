'use strict';

const { stringifyFrontmatter } = require('../frontmatter');
const { mapHookEvent, sourceTools } = require('../normalize');
const { stableStringify, tomlArray, tomlInlineTable, tomlKey, tomlString } = require('../util');
const { addConvertedSkills, addFile, addSkillBundle, finalize, mcpStandardConfig } = require('./common');

const PLUGIN_NAME = 'buildwithcli-catalog';

const adapter = {
  id: 'codex',
  displayName: 'OpenAI Codex CLI',
  capabilities: {
    skills: { native: true, strategy: '.agents/skills and plugin skills/' },
    agents: { native: true, strategy: '.codex/agents/<name>.toml and plugin agents/' },
    commands: { native: true, strategy: 'plugin commands/ plus command-to-skill fallback' },
    hooks: { native: true, strategy: '.codex/hooks.json and plugin hooks.json (trusted opt-in)' },
    mcp: { native: true, strategy: '.codex/config.toml and plugin .mcp.json' },
  },
};

function codexAgentToml(entity, warnings) {
  const tools = sourceTools(entity);
  if (tools.specified && tools.raw.length === 0) return null;

  const lines = [
    `name = ${tomlString(entity.name)}`,
    `description = ${tomlString(entity.description)}`,
    `nickname_candidates = ${tomlArray([entity.name])}`,
  ];
  const model = entity.data?.model;
  if (typeof model === 'string' && !['opus', 'sonnet', 'haiku'].includes(model.toLowerCase())) {
    lines.push(`model = ${tomlString(model)}`);
  } else if (model) {
    warnings.push({ code: 'MODEL_ALIAS_DROPPED', source: entity.sourcePath, message: `Claude model alias '${model}' is not a Codex model identifier; the active model is inherited.` });
  }

  let instructions = entity.body || entity.description;
  if (tools.specified) {
    const allowList = tools.raw.join(', ');
    instructions = [
      `Source tool policy (hard behavioral constraint): only use these source-equivalent capabilities: ${allowList}.`,
      'Do not invoke unrelated tools merely because the Codex host exposes them. Ask for explicit user approval before deviating from this source policy.',
      '',
      instructions,
    ].join('\n');
    if (!tools.capabilities.includes('edit') && !tools.capabilities.includes('execute')) {
      // Codex role files flatten ConfigToml, so this is a host-enforced write boundary.
      lines.push('sandbox_mode = "read-only"');
    }
    if (tools.unknown.length) warnings.push({
      code: 'UNKNOWN_TOOLS',
      source: entity.sourcePath,
      message: `Codex could not map source tools: ${tools.unknown.join(', ')}. They remain documented only and are not treated as permission grants.`,
    });
    warnings.push({
      code: 'CODEX_AGENT_TOOL_POLICY_PARTIAL',
      source: entity.sourcePath,
      message: `Codex role files do not expose an exact per-agent tool-name allow-list. The source list (${allowList}) is preserved as a hard instruction${lines.includes('sandbox_mode = "read-only"') ? ' and filesystem writes are host-blocked with sandbox_mode=read-only' : ''}.`,
    });
  }

  lines.push(`developer_instructions = ${tomlString(instructions)}`);
  return lines.join('\n') + '\n';
}

function omittedAgentMarkdown(entity) {
  return [
    `# Omitted Codex agent: ${entity.name}`,
    '',
    `Source: \`${entity.sourcePath}\``,
    '',
    'This source agent declares an explicit empty tool allow-list. Codex role files do not provide an exact deny-all tool switch, so BuildWithCLI intentionally did not emit an executable Codex role or converted skill for it.',
    '',
    '## Original instructions',
    '',
    entity.body || entity.description,
    '',
  ].join('\n');
}

function splitRemoteHeaders(server) {
  const literal = {};
  const env = { ...(server.envHeaders || {}) };
  let bearerTokenEnvVar = server.bearerTokenEnvVar;
  for (const [name, raw] of Object.entries(server.headers || {})) {
    const value = String(raw);
    const direct = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/) || value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
    const bearer = value.match(/^Bearer\s+\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/i) || value.match(/^Bearer\s+\$([A-Za-z_][A-Za-z0-9_]*)$/i);
    if (/^authorization$/i.test(name) && bearer) bearerTokenEnvVar ||= bearer[1];
    else if (direct) env[name] = direct[1];
    else literal[name] = value;
  }
  return { literal, env, bearerTokenEnvVar };
}

function codexConfigToml(catalog, includeHooks, warnings) {
  const lines = ['[features]', 'multi_agent = true'];
  if (includeHooks) lines.push('codex_hooks = true');
  for (const server of catalog.mcps) {
    lines.push('', `[mcp_servers.${tomlKey(server.name)}]`);
    if (server.url) {
      lines.push(`url = ${tomlString(server.url)}`);
      const headers = splitRemoteHeaders(server);
      if (Object.keys(headers.literal).length) lines.push(`http_headers = ${tomlInlineTable(headers.literal)}`);
      if (Object.keys(headers.env).length) lines.push(`env_http_headers = ${tomlInlineTable(headers.env)}`);
      if (headers.bearerTokenEnvVar) lines.push(`bearer_token_env_var = ${tomlString(headers.bearerTokenEnvVar)}`);
    } else {
      lines.push(`command = ${tomlString(server.command)}`);
      if (server.args?.length) lines.push(`args = ${tomlArray(server.args)}`);
      if (server.cwd) lines.push(`cwd = ${tomlString(server.cwd)}`);
      if (Object.keys(server.env || {}).length) lines.push(`env = ${tomlInlineTable(server.env)}`);
    }
    if (server.startupTimeoutSec != null) lines.push(`startup_timeout_sec = ${Number(server.startupTimeoutSec)}`);
    if (server.toolTimeoutSec != null) lines.push(`tool_timeout_sec = ${Number(server.toolTimeoutSec)}`);
    if (server.enabled === false) lines.push('enabled = false');
  }
  return lines.join('\n') + '\n';
}

function prepareHooks(hooks, warnings) {
  const supported = new Set(['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'PreCompact', 'PostCompact', 'SubagentStop', 'SubagentStart', 'PermissionRequest']);
  const output = {};
  for (const hook of hooks) {
    const event = mapHookEvent(hook.event, 'codex');
    if (!event || !supported.has(event)) {
      warnings.push({ code: 'HOOK_EVENT_UNSUPPORTED', source: hook.sourcePath, message: `Codex has no supported mapping for ${hook.event}.` });
      continue;
    }
    const matcher = String(hook.matcher || '*');
    if (matcher.length > 256) {
      warnings.push({ code: 'HOOK_MATCHER_TOO_LONG', source: hook.sourcePath, message: 'Hook matcher exceeds the 256-character portability limit.' });
      continue;
    }
    try { if (matcher !== '*') new RegExp(matcher); } catch {
      warnings.push({ code: 'HOOK_MATCHER_INVALID', source: hook.sourcePath, message: `Invalid matcher regex '${matcher}'.` });
      continue;
    }
    const item = {
      type: 'command',
      command: hook.command,
      timeout: Math.min(3600, Math.max(1, Number(hook.timeoutSec || 30))),
      ...(hook.cwd ? { cwd: hook.cwd } : {}),
      ...(Object.keys(hook.env || {}).length ? { env: hook.env } : {}),
    };
    (output[event] ||= []).push({ matcher, hooks: [item] });
  }
  return { hooks: output };
}

function pluginManifest({ includeHooks, includeMcp }) {
  return {
    name: PLUGIN_NAME,
    version: '1.0.0',
    description: 'Portable BuildWithCLI skills, agents, commands, hooks, and MCP integrations',
    author: { name: 'BuildWithCLI Community', url: 'https://github.com/groxaxo/buildwithcli' },
    repository: 'https://github.com/groxaxo/buildwithcli',
    license: 'MIT',
    keywords: ['codex', 'agents', 'skills', 'mcp', 'automation'],
    skills: './skills/',
    ...(includeHooks ? { hooks: './hooks.json' } : {}),
    ...(includeMcp ? { mcpServers: './.mcp.json' } : {}),
  };
}

function installMarkdown() {
  return `# Install in Codex CLI\n\n## Project-native layout\n\nCopy or merge \`.agents/skills\`, \`.codex/agents\`, \`.codex/config.toml\`, and (only when trusted) \`.codex/hooks.json\` into the project root. Merge TOML sections when a destination config already exists.\n\n## Plugin layout\n\nThis directory also contains a Codex plugin manifest at \`.codex-plugin/plugin.json\` with default-discovered \`skills/\`, \`agents/\`, and \`commands/\` surfaces. Add it to a personal or project marketplace according to your Codex installation policy.\n`;
}

async function render(catalog, options = {}) {
  const files = new Map();
  const warnings = [];
  const degradations = [];

  for (const skill of catalog.skills) {
    addSkillBundle(files, skill, '.agents/skills', 'codex');
    addSkillBundle(files, skill, 'skills', 'codex');
  }

  const executableAgents = [];
  const omittedAgents = [];
  for (const agent of catalog.agents) {
    const tools = sourceTools(agent);
    if (tools.specified && tools.raw.length === 0) omittedAgents.push(agent);
    else executableAgents.push(agent);
  }
  const convertedCatalog = { ...catalog, agents: executableAgents };
  addConvertedSkills(files, convertedCatalog, '.agents/skills', 'codex', { warnings });
  addConvertedSkills(files, convertedCatalog, 'skills', 'codex', { warnings });

  for (const agent of executableAgents) {
    const content = codexAgentToml(agent, warnings);
    addFile(files, `.codex/agents/${agent.name}.toml`, content, agent.sourcePath);
    addFile(files, `agents/${agent.name}.toml`, content, agent.sourcePath);
  }
  for (const agent of omittedAgents) {
    addFile(files, `unsupported/agents/${agent.name}.md`, omittedAgentMarkdown(agent), agent.sourcePath);
    warnings.push({
      code: 'CODEX_AGENT_OMITTED_DENY_ALL',
      source: agent.sourcePath,
      message: `Agent '${agent.name}' declares tools: [] and was omitted from executable Codex surfaces because Codex has no exact per-role deny-all tool switch.`,
    });
  }
  for (const command of catalog.commands) {
    addFile(files, `commands/${command.name}.md`, stringifyFrontmatter({ description: command.description }, command.body), command.sourcePath);
  }

  let hookConfig = null;
  if (options.includeHooks) {
    hookConfig = prepareHooks(catalog.hooks, warnings);
    if (!Object.keys(hookConfig.hooks).length) hookConfig = null;
  } else if (catalog.hooks.length) {
    warnings.push({ code: 'HOOKS_DISABLED', message: `${catalog.hooks.length} executable hooks were not emitted; rerun with --hooks trusted --trust-hooks after review.` });
  }

  addFile(files, '.codex/config.toml', codexConfigToml(catalog, Boolean(hookConfig), warnings), 'generated:config');
  if (hookConfig) {
    addFile(files, '.codex/hooks.json', stableStringify(hookConfig), 'generated:hooks');
    addFile(files, 'hooks.json', stableStringify(hookConfig), 'generated:hooks');
  }
  if (catalog.mcps.length) addFile(files, '.mcp.json', stableStringify(mcpStandardConfig(catalog)), 'generated:mcp');
  addFile(files, '.codex-plugin/plugin.json', stableStringify(pluginManifest({ includeHooks: Boolean(hookConfig), includeMcp: catalog.mcps.length > 0 })), 'generated:manifest');
  addFile(files, 'INSTALL.md', installMarkdown(), 'generated:docs');

  if (catalog.commands.length) degradations.push({
    code: 'COMMAND_SURFACE_VARIANCE',
    message: 'Codex plugin commands are preserved, and each command is also compiled to an Agent Skill because command discovery differs across Codex surfaces and versions.',
  });
  if (executableAgents.some((agent) => sourceTools(agent).specified)) degradations.push({
    code: 'CODEX_AGENT_TOOL_POLICY_ADVISORY',
    message: 'Codex supports per-role configuration and sandboxing but not an exact per-agent tool-name allow-list. Explicit source lists are preserved in developer instructions, and read/search-only roles are forced into read-only sandbox mode.',
  });
  if (omittedAgents.length) degradations.push({
    code: 'CODEX_DENY_ALL_AGENT_OMITTED',
    message: `${omittedAgents.length} explicit deny-all agent(s) were exported as non-executable documentation instead of being widened into executable Codex roles.`,
  });
  if (catalog.mcps.length) degradations.push({
    code: 'CONFIG_MERGE_REQUIRED',
    message: 'Merge generated .codex/config.toml tables into existing project configuration instead of replacing unrelated settings.',
  });
  return finalize(files, 'codex', catalog, adapter, warnings, degradations, options);
}

module.exports = {
  PLUGIN_NAME,
  adapter,
  codexAgentToml,
  codexConfigToml,
  omittedAgentMarkdown,
  pluginManifest,
  prepareHooks,
  render,
  splitRemoteHeaders,
};
