'use strict';

const { stringifyFrontmatter } = require('../frontmatter');
const { mapHookEvent, normalizedToolKey, normalizeMatcher, sourceTools } = require('../normalize');
const { stableStringify } = require('../util');
const { addFile, addSkillBundle, finalize } = require('./common');

const adapter = {
  id: 'opencode',
  displayName: 'OpenCode',
  capabilities: {
    skills: { native: true, strategy: '.opencode/skills/<name>/SKILL.md' },
    agents: { native: true, strategy: '.opencode/agents/<name>.md' },
    commands: { native: true, strategy: '.opencode/commands/<name>.md' },
    hooks: { native: true, strategy: '.opencode/plugins/buildwithcli-hooks.js (trusted opt-in)' },
    mcp: { native: true, strategy: 'opencode.json mcp object' },
  },
};

const TOOL_PERMISSION_KEYS = {
  read: ['read'], notebookread: ['read'], view: ['read'], cat: ['read'], readfile: ['read'],
  write: ['edit'], edit: ['edit'], multiedit: ['edit'], notebookedit: ['edit'], applypatch: ['edit'], patch: ['edit'], writefile: ['edit'],
  bash: ['bash'], shell: ['bash'], execute: ['bash'], terminal: ['bash'], powershell: ['bash'], shell_exec: ['bash'],
  grep: ['grep'], search: ['grep'], find: ['grep'], glob: ['glob'], ls: ['list'], list: ['list'], lsp: ['lsp'],
  webfetch: ['webfetch'], fetch: ['webfetch'], web: ['webfetch'], browser: ['webfetch'], websearch: ['websearch'],
  task: ['task'], agent: ['task'], delegatetask: ['task'], subagent: ['task'],
  todowrite: ['todowrite'], todo: ['todowrite'], manage_todo_list: ['todowrite'],
  skill: ['skill'], skillview: ['skill'], skill_view: ['skill'],
};

const OPENCODE_MATCHER_ALIASES = {
  read: ['read'], notebookread: ['read'], view: ['read'], cat: ['read'], readfile: ['read'],
  write: ['write'], writefile: ['write'],
  edit: ['edit', 'apply_patch'], multiedit: ['edit', 'apply_patch'], notebookedit: ['edit', 'apply_patch'], applypatch: ['apply_patch'], patch: ['apply_patch'],
  bash: ['bash'], shell: ['bash'], execute: ['bash'], terminal: ['bash'], powershell: ['bash'], shell_exec: ['bash'],
  grep: ['grep'], search: ['grep'], find: ['grep'], glob: ['glob'], ls: ['list'], list: ['list'], lsp: ['lsp'],
  webfetch: ['webfetch'], fetch: ['webfetch'], web: ['webfetch'], browser: ['webfetch'], websearch: ['websearch'],
  task: ['task'], agent: ['task'], delegatetask: ['task'], subagent: ['task'],
  todowrite: ['todowrite'], todo: ['todowrite'], manage_todo_list: ['todowrite'],
  skill: ['skill'], skillview: ['skill'], skill_view: ['skill'],
};

function opencodeMatcherPatterns(matcher) {
  const output = [];
  for (const pattern of matcher.patterns) {
    if (pattern === '*') {
      output.push('*');
      continue;
    }
    // Preserve wildcard intent, but normalize case because OpenCode tool IDs are lower-case.
    if (pattern.includes('*') || pattern.includes('?')) {
      output.push(pattern.toLowerCase());
      continue;
    }
    const aliases = OPENCODE_MATCHER_ALIASES[normalizedToolKey(pattern)];
    output.push(...(aliases || [pattern.toLowerCase()]));
  }
  return [...new Set(output)];
}

function opencodePermissions(entity) {
  const tools = sourceTools(entity);
  if (!tools.specified) return { permission: null, unknown: tools.unknown, specified: false };
  const permission = { '*': 'deny' };
  const unknown = [...tools.unknown];
  for (const raw of tools.raw) {
    const keys = TOOL_PERMISSION_KEYS[normalizedToolKey(raw)];
    if (!keys) {
      if (!unknown.includes(raw)) unknown.push(raw);
      continue;
    }
    for (const key of keys) permission[key] = 'allow';
  }
  return { permission, unknown, specified: true };
}


function renderAgent(entity, warnings) {
  const { permission, unknown } = opencodePermissions(entity);
  if (unknown.length) warnings.push({
    code: 'UNKNOWN_TOOLS', source: entity.sourcePath,
    message: `OpenCode could not map source tools: ${unknown.join(', ')}. They remain denied because the source declared an explicit tool list.`,
  });
  const data = { description: entity.description, mode: 'subagent' };
  if (permission) data.permission = permission;
  const model = entity.data?.model;
  if (typeof model === 'string' && model.includes('/')) data.model = model;
  else if (model) warnings.push({
    code: 'MODEL_ALIAS_DROPPED', source: entity.sourcePath,
    message: `Model alias '${model}' is not an OpenCode provider/model identifier; the active model is inherited.`,
  });
  return stringifyFrontmatter(data, entity.body);
}

function renderCommand(entity, warnings) {
  const data = { description: entity.description };
  if (entity.data?.agent && typeof entity.data.agent === 'string') data.agent = entity.data.agent;
  const model = entity.data?.model;
  if (typeof model === 'string' && model.includes('/')) data.model = model;
  else if (model) warnings.push({
    code: 'MODEL_ALIAS_DROPPED', source: entity.sourcePath,
    message: `Model alias '${model}' is not an OpenCode provider/model identifier; the active model is inherited.`,
  });
  return stringifyFrontmatter(data, entity.body);
}

function opencodeEnvReference(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '{env:$1}')
    .replace(/(^|[^$A-Za-z0-9_])\$([A-Za-z_][A-Za-z0-9_]*)/g, '$1{env:$2}');
}

function opencodeHeaders(server) {
  const headers = {};
  for (const [name, value] of Object.entries(server.headers || {})) {
    headers[name] = opencodeEnvReference(value);
  }
  for (const [name, envName] of Object.entries(server.envHeaders || {})) {
    if (!Object.prototype.hasOwnProperty.call(headers, name)) headers[name] = `{env:${envName}}`;
  }
  if (server.bearerTokenEnvVar && !Object.keys(headers).some((name) => /^authorization$/i.test(name))) {
    headers.Authorization = `Bearer {env:${server.bearerTokenEnvVar}}`;
  }
  return headers;
}

function opencodeMcp(catalog) {
  const mcp = {};
  for (const server of catalog.mcps) {
    if (server.url) {
      const headers = opencodeHeaders(server);
      mcp[server.name] = {
        type: 'remote',
        url: server.url,
        enabled: server.enabled,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(server.toolTimeoutSec != null ? { timeout: server.toolTimeoutSec * 1000 } : {}),
      };
    } else {
      mcp[server.name] = {
        type: 'local',
        command: [server.command, ...(server.args || [])],
        enabled: server.enabled,
        ...(server.cwd ? { cwd: server.cwd } : {}),
        ...(Object.keys(server.env || {}).length ? { environment: server.env } : {}),
        ...(server.toolTimeoutSec != null ? { timeout: server.toolTimeoutSec * 1000 } : {}),
      };
    }
  }
  return { $schema: 'https://opencode.ai/config.json', mcp };
}

function prepareHooks(hooks, warnings) {
  const supportedEvents = new Set([
    'tool.execute.before', 'tool.execute.after', 'session.created', 'session.idle',
    'session.deleted', 'session.compacted', 'notification',
  ]);
  const result = [];
  for (const hook of hooks) {
    const event = mapHookEvent(hook.event, 'opencode');
    if (!event || !supportedEvents.has(event)) {
      warnings.push({ code: 'HOOK_EVENT_UNSUPPORTED', source: hook.sourcePath, message: `OpenCode has no safe mapping for ${hook.event}.` });
      continue;
    }
    const matcher = normalizeMatcher(hook.matcher);
    if (!matcher.supported) {
      warnings.push({ code: 'HOOK_MATCHER_UNSUPPORTED', source: hook.sourcePath, message: `Matcher '${hook.matcher}' uses regex syntax that is unsafe to translate automatically.` });
      continue;
    }
    result.push({
      name: hook.name,
      event,
      patterns: opencodeMatcherPatterns(matcher),
      command: hook.command,
      cwd: hook.cwd || null,
      env: hook.env || {},
      timeoutMs: Math.min(3_600_000, Math.max(1000, Number(hook.timeoutSec || 30) * 1000)),
    });
  }
  return result;
}

function hookPlugin(hooks, warnings, degradations) {
  const prepared = prepareHooks(hooks, warnings);
  if (!prepared.length) return null;
  degradations.push({
    code: 'HOOK_PROTOCOL_TRANSLATION',
    message: 'Hook commands receive a bounded JSON payload on stdin. A failing pre-tool hook blocks execution by throwing; host-specific JSON rewrite payloads are not translated.',
  });
  return [
    '// Generated by BuildWithCLI. Executable only after explicit trust.',
    'import { spawn } from "node:child_process"',
    'import { isAbsolute, resolve } from "node:path"',
    '',
    `const hooks = ${JSON.stringify(prepared, null, 2)}`,
    'const MAX_IO_BYTES = 1024 * 1024',
    '',
    'function wildcard(pattern, value) {',
    '  if (pattern === "*") return true',
    '  const normalizedPattern = String(pattern).toLowerCase()',
    '  const normalizedValue = String(value || "").toLowerCase()',
    '  const escaped = normalizedPattern.replace(/[|\\{}()[\\]^$+?.]/g, "\\\\$&").replace(/\\*/g, ".*").replace(/\\?/g, ".")',
    '  return new RegExp("^" + escaped + "$").test(normalizedValue)',
    '}',
    '',
    'function matches(patterns, value) {',
    '  return !patterns.length || patterns.some(pattern => wildcard(pattern, value))',
    '}',
    '',
    'function signalChild(child, signal) {',
    '  if (child.exitCode != null || child.killed) return',
    '  if (process.platform !== "win32" && child.pid) {',
    '    try { process.kill(-child.pid, signal); return } catch {}',
    '  }',
    '  try { child.kill(signal) } catch {}',
    '}',
    '',
    'function terminate(child) {',
    '  signalChild(child, "SIGTERM")',
    '  setTimeout(() => signalChild(child, "SIGKILL"), 750).unref()',
    '}',
    '',
    'function runHook(hook, payload, directory) {',
    '  return new Promise((resolvePromise, rejectPromise) => {',
    '    const input = Buffer.from(JSON.stringify(payload ?? {}), "utf8")',
    '    if (input.length > MAX_IO_BYTES) {',
    '      rejectPromise(new Error("Hook " + hook.name + " input exceeded " + MAX_IO_BYTES + " bytes"))',
    '      return',
    '    }',
    '    const baseDirectory = directory || process.cwd()',
    '    const hookCwd = hook.cwd ? (isAbsolute(hook.cwd) ? hook.cwd : resolve(baseDirectory, hook.cwd)) : baseDirectory',
    '    const child = spawn(hook.command, {',
    '      cwd: hookCwd,',
    '      env: { ...process.env, ...hook.env, BUILDWITHCLI_EVENT: hook.event, BUILDWITHCLI_HOOK: hook.name },',
    '      shell: true,',
    '      detached: process.platform !== "win32",',
    '      stdio: ["pipe", "pipe", "pipe"],',
    '    })',
    '    let stdout = Buffer.alloc(0)',
    '    let stderr = Buffer.alloc(0)',
    '    let outputBytes = 0',
    '    let settled = false',
    '    let timer = null',
    '    const finish = (error, result) => {',
    '      if (settled) return',
    '      settled = true',
    '      if (timer) clearTimeout(timer)',
    '      error ? rejectPromise(error) : resolvePromise(result)',
    '    }',
    '    const collect = (current, chunk) => {',
    '      outputBytes += chunk.length',
    '      if (outputBytes > MAX_IO_BYTES) {',
    '        terminate(child)',
    '        finish(new Error("Hook " + hook.name + " exceeded " + MAX_IO_BYTES + " output bytes"))',
    '        return current',
    '      }',
    '      return Buffer.concat([current, chunk])',
    '    }',
    '    child.stdout.on("data", chunk => { stdout = collect(stdout, chunk) })',
    '    child.stderr.on("data", chunk => { stderr = collect(stderr, chunk) })',
    '    child.on("error", error => finish(error))',
    '    child.on("close", code => {',
    '      const out = stdout.toString("utf8")',
    '      const err = stderr.toString("utf8")',
    '      if (code === 0) finish(null, { stdout: out, stderr: err })',
    '      else finish(new Error("Hook " + hook.name + " failed (" + code + "): " + (err || out)))',
    '    })',
    '    timer = setTimeout(() => {',
    '      terminate(child)',
    '      finish(new Error("Hook " + hook.name + " timed out after " + hook.timeoutMs + "ms"))',
    '    }, hook.timeoutMs)',
    '    timer.unref()',
    '    child.stdin.on("error", error => { if (error.code !== "EPIPE") finish(error) })',
    '    child.stdin.end(input)',
    '  })',
    '}',
    '',
    'export const BuildWithCLIHooks = async ({ directory }) => ({',
    '  "tool.execute.before": async (input, output) => {',
    '    for (const hook of hooks.filter(h => h.event === "tool.execute.before" && matches(h.patterns, input.tool))) {',
    '      await runHook(hook, { input, output }, directory)',
    '    }',
    '  },',
    '  "tool.execute.after": async (input, output) => {',
    '    for (const hook of hooks.filter(h => h.event === "tool.execute.after" && matches(h.patterns, input.tool))) {',
    '      await runHook(hook, { input, output }, directory)',
    '    }',
    '  },',
    '  event: async ({ event }) => {',
    '    for (const hook of hooks.filter(h => h.event === event.type)) await runHook(hook, event, directory)',
    '  },',
    '})',
    '',
  ].join('\n');
}

async function render(catalog, options = {}) {
  const files = new Map();
  const warnings = [];
  const degradations = [];
  for (const skill of catalog.skills) addSkillBundle(files, skill, '.opencode/skills', 'opencode');
  for (const agent of catalog.agents) addFile(files, `.opencode/agents/${agent.name}.md`, renderAgent(agent, warnings), agent.sourcePath);
  for (const command of catalog.commands) addFile(files, `.opencode/commands/${command.name}.md`, renderCommand(command, warnings), command.sourcePath);
  if (catalog.mcps.length) {
    addFile(files, 'opencode.json', stableStringify(opencodeMcp(catalog)), 'generated:mcp');
    degradations.push({ code: 'CONFIG_MERGE_REQUIRED', message: 'If the destination already has opencode.json, merge the generated mcp object instead of replacing unrelated settings.' });
  }
  if (options.includeHooks) {
    const plugin = hookPlugin(catalog.hooks, warnings, degradations);
    if (plugin) addFile(files, '.opencode/plugins/buildwithcli-hooks.js', plugin, 'generated:hooks');
  } else if (catalog.hooks.length) {
    warnings.push({ code: 'HOOKS_DISABLED', message: `${catalog.hooks.length} executable hooks were not emitted; rerun with --hooks trusted --trust-hooks after review.` });
  }
  return finalize(files, 'opencode', catalog, adapter, warnings, degradations, options);
}

module.exports = { OPENCODE_MATCHER_ALIASES, TOOL_PERMISSION_KEYS, adapter, hookPlugin, opencodeEnvReference, opencodeHeaders, opencodeMcp, opencodeMatcherPatterns, opencodePermissions, prepareHooks, render, renderAgent, renderCommand };
