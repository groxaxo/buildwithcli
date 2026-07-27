'use strict';

const { stringifyFrontmatter } = require('../frontmatter');
const { canonicalHookEvent, normalizedToolKey, normalizeMatcher, sourceTools } = require('../normalize');
const { stableStringify } = require('../util');
const { addConvertedSkills, addFile, addSkillBundle, finalize } = require('./common');

const PLUGIN_NAME = 'buildwithcli-catalog';

const adapter = {
  id: 'copilot',
  displayName: 'GitHub Copilot CLI',
  capabilities: {
    skills: { native: true, strategy: 'plugin skills/ and .github/skills' },
    agents: { native: true, strategy: 'plugin agents/*.agent.md and .github/agents' },
    commands: { native: true, strategy: 'plugin commands/ and .claude/commands' },
    hooks: { native: true, strategy: 'hooks.json and .github/hooks/buildwithcli.json (trusted opt-in)' },
    mcp: { native: true, strategy: '.mcp.json and .github/mcp.json' },
  },
};

// Copilot custom agents require concrete runtime tool names. These aliases are
// intentionally conservative: an explicit source allow-list is never widened.
const TOOL_ALIASES = {
  read: ['view'], notebookread: ['view'], view: ['view'], cat: ['view'], readfile: ['view'],
  write: ['create'], writefile: ['create'],
  edit: ['edit', 'apply_patch'], multiedit: ['edit', 'apply_patch'], notebookedit: ['edit', 'apply_patch'], applypatch: ['apply_patch'], patch: ['apply_patch'],
  bash: ['bash', 'powershell'], shell: ['bash', 'powershell'], execute: ['bash', 'powershell'], terminal: ['bash', 'powershell'], shell_exec: ['bash', 'powershell'], powershell: ['powershell'],
  grep: ['grep'], search: ['grep'], find: ['grep'], glob: ['glob'],
  webfetch: ['web_fetch'], fetch: ['web_fetch'], web: ['web_fetch'], browser: ['web_fetch'], websearch: ['web_search'],
  task: ['task'], agent: ['task'], delegatetask: ['task'], subagent: ['task'],
  todowrite: ['update_todo'], todo: ['update_todo'], manage_todo_list: ['update_todo'],
  skill: ['skill'], skillview: ['skill'], skill_view: ['skill'],
};

function copilotTools(entity, warnings) {
  const tools = sourceTools(entity);
  if (!tools.specified) return null;
  const mapped = [];
  const unknown = [...tools.unknown];
  for (const raw of tools.raw) {
    const aliases = TOOL_ALIASES[normalizedToolKey(raw)];
    if (aliases) mapped.push(...aliases);
    else if (!unknown.includes(raw)) unknown.push(raw);
  }
  if (unknown.length) warnings.push({
    code: 'UNKNOWN_TOOLS', source: entity.sourcePath,
    message: `Copilot could not map source tools: ${unknown.join(', ')}. Because the source declared a tool list, only exact, safely mapped runtime tools are emitted.`,
  });
  return [...new Set(mapped)];
}


function renderAgent(entity, warnings) {
  const data = {
    name: entity.name,
    description: entity.description,
  };
  const tools = copilotTools(entity, warnings);
  if (tools !== null) data.tools = tools;
  const model = entity.data?.model;
  if (typeof model === 'string' && !['opus', 'sonnet', 'haiku'].includes(model.toLowerCase())) data.model = model;
  else if (model) warnings.push({ code: 'MODEL_ALIAS_DROPPED', source: entity.sourcePath, message: `Claude model alias '${model}' is not portable to Copilot CLI; the active model is inherited.` });
  return stringifyFrontmatter(data, entity.body);
}

function renderCommand(entity) {
  const data = { description: entity.description };
  if (entity.data?.['argument-hint']) data['argument-hint'] = entity.data['argument-hint'];
  if (entity.data?.['allowed-tools']) data['allowed-tools'] = entity.data['allowed-tools'];
  return stringifyFrontmatter(data, entity.body);
}

const COPILOT_HOOK_EVENTS = {
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  Stop: 'Stop',
  Notification: 'notification',
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  UserPromptSubmit: 'UserPromptSubmit',
  PreCompact: 'PreCompact',
  SubagentStop: 'SubagentStop',
  SubagentStart: 'subagentStart',
  PermissionRequest: 'PermissionRequest',
};

const MATCHER_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'PermissionRequest',
  'notification', 'PreCompact', 'subagentStart',
]);

const COPILOT_RUNTIME_MATCHER_ALIASES = {
  read: ['view'], notebookread: ['view'], view: ['view'], cat: ['view'], readfile: ['view'],
  write: ['create'], writefile: ['create'],
  edit: ['edit', 'apply_patch'], multiedit: ['edit', 'apply_patch'], notebookedit: ['edit', 'apply_patch'], applypatch: ['apply_patch'], patch: ['apply_patch'],
  bash: ['bash', 'powershell'], shell: ['bash', 'powershell'], execute: ['bash', 'powershell'], terminal: ['bash', 'powershell'], shell_exec: ['bash', 'powershell'], powershell: ['powershell'],
  grep: ['grep'], search: ['grep'], find: ['grep'], glob: ['glob'],
  webfetch: ['web_fetch'], fetch: ['web_fetch'], web: ['web_fetch'], browser: ['web_fetch'], websearch: ['web_search'],
  task: ['task'], agent: ['task'], delegatetask: ['task'], subagent: ['task'],
  todowrite: ['update_todo'], todo: ['update_todo'], manage_todo_list: ['update_todo'],
  skill: ['skill'], skillview: ['skill'], skill_view: ['skill'],
};

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wildcardToRegex(value) {
  return regexEscape(value).replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
}

function copilotRuntimeMatcher(matcher) {
  const fragments = [];
  for (const pattern of matcher.patterns) {
    if (pattern === '*') return null;
    if (pattern.includes('*') || pattern.includes('?')) {
      fragments.push(wildcardToRegex(pattern.toLowerCase()));
      continue;
    }
    const aliases = COPILOT_RUNTIME_MATCHER_ALIASES[normalizedToolKey(pattern)];
    for (const alias of aliases || [pattern.toLowerCase()]) fragments.push(regexEscape(alias));
  }
  const unique = [...new Set(fragments)];
  return unique.length ? `^(?:${unique.join('|')})$` : null;
}

function prepareHooks(hooks, warnings) {
  const result = {};
  for (const hook of hooks) {
    const canonical = canonicalHookEvent(hook.event);
    const event = COPILOT_HOOK_EVENTS[canonical];
    if (!event) {
      warnings.push({ code: 'HOOK_EVENT_UNSUPPORTED', source: hook.sourcePath, message: `Copilot CLI has no safe native mapping for ${hook.event}.` });
      continue;
    }
    const matcher = normalizeMatcher(hook.matcher);
    if (!matcher.supported) {
      warnings.push({ code: 'HOOK_MATCHER_UNSUPPORTED', source: hook.sourcePath, message: `Matcher '${hook.matcher}' is too broad or malformed to emit safely.` });
      continue;
    }
    if (!hook.commandWindows) {
      warnings.push({
        code: 'HOOK_WINDOWS_COMMAND_MISSING', source: hook.sourcePath,
        message: `Hook '${hook.name}' has no PowerShell implementation. Copilot will use its cross-platform command fallback on Windows.`,
      });
    }
    const emittedMatcher = event === 'PostToolUse' ? copilotRuntimeMatcher(matcher) : (matcher.raw === '*' ? null : matcher.raw);
    const item = {
      type: 'command',
      command: hook.command,
      bash: hook.command,
      ...(hook.commandWindows ? { powershell: hook.commandWindows } : {}),
      ...(emittedMatcher && MATCHER_EVENTS.has(event) ? { matcher: emittedMatcher } : {}),
      ...(hook.cwd ? { cwd: hook.cwd } : {}),
      ...(Object.keys(hook.env || {}).length ? { env: hook.env } : {}),
      timeoutSec: Math.min(3600, Math.max(1, Number(hook.timeoutSec || 30))),
    };
    if (matcher.raw !== '*' && !MATCHER_EVENTS.has(event)) {
      warnings.push({
        code: 'HOOK_MATCHER_DROPPED', source: hook.sourcePath,
        message: `Copilot does not define matcher filtering for ${event}; matcher '${matcher.raw}' was not emitted.`,
      });
    }
    (result[event] ||= []).push(item);
  }
  return { version: 1, disableAllHooks: false, hooks: result };
}

function copilotHeaders(server) {
  const headers = { ...(server.headers || {}) };
  for (const [name, envName] of Object.entries(server.envHeaders || {})) {
    if (!Object.prototype.hasOwnProperty.call(headers, name)) headers[name] = `\${${envName}}`;
  }
  if (server.bearerTokenEnvVar && !Object.keys(headers).some((name) => /^authorization$/i.test(name))) {
    headers.Authorization = `Bearer \${${server.bearerTokenEnvVar}}`;
  }
  return headers;
}

function copilotMcpConfig(catalog, warnings = []) {
  const mcpServers = {};
  for (const server of catalog.mcps) {
    if (server.enabled === false) {
      warnings.push({
        code: 'MCP_DISABLED_OMITTED', source: server.sourcePath,
        message: `Disabled MCP server '${server.name}' was omitted because Copilot's MCP file schema has no per-server enabled flag.`,
      });
      continue;
    }
    const timeoutSec = server.toolTimeoutSec ?? server.startupTimeoutSec;
    if (server.url) {
      const headers = copilotHeaders(server);
      mcpServers[server.name] = {
        type: 'http',
        url: server.url,
        tools: ['*'],
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(timeoutSec != null ? { timeout: Math.max(1, Math.round(Number(timeoutSec) * 1000)) } : {}),
      };
    } else {
      mcpServers[server.name] = {
        type: 'local',
        command: server.command,
        args: server.args || [],
        tools: ['*'],
        ...(Object.keys(server.env || {}).length ? { env: server.env } : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
        ...(timeoutSec != null ? { timeout: Math.max(1, Math.round(Number(timeoutSec) * 1000)) } : {}),
      };
    }
  }
  return { mcpServers };
}

function pluginManifest({ includeHooks, includeMcp }) {
  return {
    name: PLUGIN_NAME,
    description: 'Portable BuildWithCLI agents, skills, commands, hooks, and MCP integrations',
    version: '1.0.0',
    author: { name: 'BuildWithCLI Community', url: 'https://github.com/groxaxo/buildwithcli' },
    repository: 'https://github.com/groxaxo/buildwithcli',
    license: 'MIT',
    keywords: ['copilot', 'agents', 'skills', 'mcp', 'automation'],
    agents: 'agents/',
    skills: 'skills/',
    commands: 'commands/',
    ...(includeHooks ? { hooks: 'hooks.json' } : {}),
    ...(includeMcp ? { mcpServers: '.mcp.json' } : {}),
  };
}

function installMarkdown() {
  return `# Install in GitHub Copilot CLI\n\n## Plugin\n\nInstall this directory as a local Copilot CLI plugin with \`copilot plugin install .\`, or register it in a marketplace. The root \`plugin.json\` references \`agents/\`, \`skills/\`, \`commands/\`, optional \`hooks.json\`, and optional \`.mcp.json\`.\n\n## Repository-native layout\n\nAlternatively merge the generated \`.github/agents\`, \`.github/skills\`, \`.claude/commands\`, \`.github/mcp.json\`, and trusted \`.github/hooks/buildwithcli.json\` into a repository. Existing MCP and hook files must be merged rather than overwritten.\n`;
}

async function render(catalog, options = {}) {
  const files = new Map();
  const warnings = [];
  const degradations = [];

  for (const skill of catalog.skills) {
    addSkillBundle(files, skill, 'skills', 'copilot');
    addSkillBundle(files, skill, '.github/skills', 'copilot');
  }
  addConvertedSkills(files, catalog, 'skills', 'copilot', { warnings, includeInvocationFields: true });
  addConvertedSkills(files, catalog, '.github/skills', 'copilot', { warnings, includeInvocationFields: true });

  for (const agent of catalog.agents) {
    const content = renderAgent(agent, warnings);
    addFile(files, `agents/${agent.name}.agent.md`, content, agent.sourcePath);
    addFile(files, `.github/agents/${agent.name}.agent.md`, content, agent.sourcePath);
  }
  for (const command of catalog.commands) {
    const content = renderCommand(command);
    addFile(files, `commands/${command.name}.md`, content, command.sourcePath);
    addFile(files, `.claude/commands/${command.name}.md`, content, command.sourcePath);
  }

  let hooks = null;
  if (options.includeHooks) {
    hooks = prepareHooks(catalog.hooks, warnings);
    if (!Object.keys(hooks.hooks).length) hooks = null;
  } else if (catalog.hooks.length) {
    warnings.push({ code: 'HOOKS_DISABLED', message: `${catalog.hooks.length} executable hooks were not emitted; rerun with --hooks trusted --trust-hooks after review.` });
  }
  if (hooks) {
    addFile(files, 'hooks.json', stableStringify(hooks), 'generated:hooks');
    addFile(files, '.github/hooks/buildwithcli.json', stableStringify(hooks), 'generated:hooks');
  }
  const mcpConfig = copilotMcpConfig(catalog, warnings);
  const mcpCount = Object.keys(mcpConfig.mcpServers).length;
  if (mcpCount) {
    const mcp = stableStringify(mcpConfig);
    addFile(files, '.mcp.json', mcp, 'generated:mcp');
    addFile(files, '.github/mcp.json', mcp, 'generated:mcp');
  }
  addFile(files, 'plugin.json', stableStringify(pluginManifest({ includeHooks: Boolean(hooks), includeMcp: mcpCount > 0 })), 'generated:manifest');
  addFile(files, 'INSTALL.md', installMarkdown(), 'generated:docs');

  if (catalog.commands.length) degradations.push({
    code: 'COMMAND_SKILL_FALLBACK',
    message: 'Commands are emitted natively and as user-invocable skills so the workflows remain callable across Copilot CLI plugin and repository customization surfaces.',
  });
  if (mcpCount) degradations.push({
    code: 'MCP_USER_CONFIG',
    message: 'Copilot CLI user-scoped MCP registrations live in $COPILOT_HOME/mcp-config.json. The export provides plugin and repository MCP files; install or merge them through Copilot instead of replacing user configuration.',
  });
  return finalize(files, 'copilot', catalog, adapter, warnings, degradations, options);
}

module.exports = {
  COPILOT_HOOK_EVENTS,
  COPILOT_RUNTIME_MATCHER_ALIASES,
  PLUGIN_NAME,
  TOOL_ALIASES,
  adapter,
  copilotHeaders,
  copilotMcpConfig,
  copilotRuntimeMatcher,
  copilotTools,
  pluginManifest,
  prepareHooks,
  render,
  renderAgent,
  renderCommand,
};
