'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { parseFrontmatter } = require('./frontmatter');
const { readFileLimited, walkFiles, fileExists, assertRootSafe } = require('./safe-fs');
const { canonicalHookEvent, namespaceForPath, normalizeDescription } = require('./normalize');
const { matchesAny, parseJsonc, sha256, slugify, toPosix } = require('./util');

const CURATED_ROOTS = {
  skill: 'plugins/all-skills/skills',
  agent: 'plugins/all-agents/agents',
  command: 'plugins/all-commands/commands',
  hook: 'plugins/all-hooks/hooks',
};

const CONFIG_NAMES = new Set([
  '.mcp.json', 'mcp.json', 'hooks.json', 'settings.json', 'opencode.json', 'opencode.jsonc',
]);

function sourceRank(relative) {
  if (/^plugins\/all-(skills|agents|commands|hooks)\//.test(relative)) return 0;
  if (relative.startsWith('.')) return 1;
  return 2;
}

function inferKind(relative) {
  const posix = toPosix(relative);
  if (posix.endsWith('/SKILL.md') || posix === 'SKILL.md') return 'skill';
  if (/\/(?:agents|agent)\/[^/]+\.agent\.md$/i.test(`/${posix}`)) return 'agent';
  if (/\/(?:agents|agent)\/[^/]+\.md$/i.test(`/${posix}`)) return 'agent';
  if (/\/(?:commands|command)\/[^/]+\.md$/i.test(`/${posix}`)) return 'command';
  if (/\/(?:hooks|hook)\/[^/]+\.md$/i.test(`/${posix}`)) return 'hook';
  return null;
}

function entityName(kind, relative, data) {
  if (data.name) return slugify(data.name);
  if (kind === 'skill') return slugify(path.basename(path.dirname(relative)));
  return slugify(path.basename(relative).replace(/\.agent\.md$/i, '').replace(/\.md$/i, ''));
}

async function readMarkdownEntity(sourceRoot, relative, kind, limits) {
  const absolute = path.join(sourceRoot, relative);
  const bytes = await readFileLimited(absolute, limits.maxFileBytes);
  const markdown = bytes.toString('utf8');
  const { data, body } = parseFrontmatter(markdown);
  const name = entityName(kind, relative, data);
  return {
    kind,
    name,
    originalName: data.name ? String(data.name) : name,
    description: normalizeDescription(data.description, `${name} ${kind}`),
    data,
    body,
    markdown,
    sourcePath: relative,
    sourceAbsolute: absolute,
    namespace: namespaceForPath(relative),
    contentHash: sha256(bytes),
    rank: sourceRank(relative),
  };
}

async function readSkillFiles(entity, limits) {
  const directory = path.dirname(entity.sourceAbsolute);
  const files = await walkFiles(directory, {
    maxFiles: limits.maxSkillFiles,
    maxBytes: limits.maxSkillBytes,
    maxDepth: limits.maxDepth,
    rejectSymlinks: true,
  });
  entity.bundle = [];
  for (const file of files) {
    if (file.size > limits.maxFileBytes) throw new Error(`Skill file too large: ${file.relative}`);
    entity.bundle.push({
      relative: file.relative,
      content: await readFileLimited(file.absolute, limits.maxFileBytes),
      mode: file.mode,
    });
  }
  entity.bundle.sort((a, b) => {
    if (a.relative === 'SKILL.md') return -1;
    if (b.relative === 'SKILL.md') return 1;
    return a.relative.localeCompare(b.relative);
  });
  entity.bundleRoot = directory;
  return entity;
}

function numberField(value, ...names) {
  for (const name of names) {
    const raw = value?.[name];
    if (raw == null || raw === '') continue;
    const number = Number(raw);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return undefined;
}

function ambiguousTimeoutIsMilliseconds(value, sourcePath) {
  const source = toPosix(sourcePath || '').toLowerCase();
  if (/(?:^|\/)opencode\.jsonc?$/.test(source)) return true;
  if (/(?:^|\/)\.github\/mcp\.json$/.test(source)) return true;
  // Copilot's current MCP schema requires an explicit tools array and defines timeout in milliseconds.
  if (Array.isArray(value?.tools)) return true;
  return false;
}

function normalizedTimeouts(value, sourcePath) {
  const startupSeconds = numberField(value, 'startup_timeout_sec', 'connect_timeout', 'connectTimeout', 'startupTimeoutSec');
  const startupMilliseconds = numberField(value, 'startup_timeout_ms', 'connect_timeout_ms', 'connectTimeoutMs', 'startupTimeoutMs');
  const toolSeconds = numberField(value, 'tool_timeout_sec', 'toolTimeoutSec');
  const toolMilliseconds = numberField(value, 'tool_timeout_ms', 'toolTimeoutMs');
  const ambiguous = numberField(value, 'timeout');
  return {
    startupTimeoutSec: startupSeconds ?? (startupMilliseconds != null ? startupMilliseconds / 1000 : undefined),
    toolTimeoutSec: toolSeconds
      ?? (toolMilliseconds != null ? toolMilliseconds / 1000 : undefined)
      ?? (ambiguous != null ? (ambiguousTimeoutIsMilliseconds(value, sourcePath) ? ambiguous / 1000 : ambiguous) : undefined),
  };
}

function normalizeServer(name, value, sourcePath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const commandArray = Array.isArray(value.command) ? value.command.map(String) : null;
  const command = commandArray ? commandArray[0] : value.command != null ? String(value.command) : null;
  const args = commandArray ? commandArray.slice(1) : Array.isArray(value.args) ? value.args.map(String) : [];
  const url = value.url || value.uri || value.endpoint || null;
  if (!command && !url) return null;
  const environment = value.env && typeof value.env === 'object' && !Array.isArray(value.env)
    ? value.env
    : value.environment && typeof value.environment === 'object' && !Array.isArray(value.environment)
      ? value.environment
      : {};
  const timeouts = normalizedTimeouts(value, sourcePath);
  return {
    kind: 'mcp',
    name: slugify(name),
    originalName: String(name),
    description: normalizeDescription(value.description, `MCP server ${name}`),
    command,
    args,
    cwd: value.cwd ? String(value.cwd) : undefined,
    env: Object.fromEntries(Object.entries(environment).map(([key, item]) => [String(key), String(item)])),
    url: url ? String(url) : null,
    headers: value.headers && typeof value.headers === 'object' && !Array.isArray(value.headers)
      ? Object.fromEntries(Object.entries(value.headers).map(([key, item]) => [String(key), String(item)]))
      : value.http_headers && typeof value.http_headers === 'object' && !Array.isArray(value.http_headers)
        ? Object.fromEntries(Object.entries(value.http_headers).map(([key, item]) => [String(key), String(item)]))
        : {},
    envHeaders: value.env_http_headers && typeof value.env_http_headers === 'object' && !Array.isArray(value.env_http_headers)
      ? Object.fromEntries(Object.entries(value.env_http_headers).map(([key, item]) => [String(key), String(item)]))
      : {},
    bearerTokenEnvVar: value.bearer_token_env_var ? String(value.bearer_token_env_var) : undefined,
    enabled: value.enabled !== false && value.disabled !== true,
    startupTimeoutSec: timeouts.startupTimeoutSec,
    toolTimeoutSec: timeouts.toolTimeoutSec,
    sourcePath,
    raw: value,
    namespace: namespaceForPath(sourcePath),
    rank: sourceRank(sourcePath),
    contentHash: sha256(JSON.stringify(value)),
  };
}

function extractMcpServers(json, sourcePath) {
  const containers = [];
  for (const key of ['mcpServers', 'mcp_servers', 'servers', 'mcp']) {
    if (json?.[key] && typeof json[key] === 'object' && !Array.isArray(json[key])) containers.push(json[key]);
  }
  const result = [];
  for (const container of containers) {
    for (const [name, value] of Object.entries(container)) {
      const server = normalizeServer(name, value, sourcePath);
      if (server) result.push(server);
    }
  }
  return result;
}

function commandFromHookItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (item.type && !['command', 'shell'].includes(String(item.type))) return null;
  const command = item.command || item.bash || null;
  if (!command) return null;
  return {
    command: String(command),
    commandWindows: item.powershell ? String(item.powershell) : undefined,
    cwd: item.cwd ? String(item.cwd) : undefined,
    env: item.env && typeof item.env === 'object' && !Array.isArray(item.env)
      ? Object.fromEntries(Object.entries(item.env).map(([key, value]) => [String(key), String(value)]))
      : {},
    timeoutSec: Math.min(3600, Math.max(1, Number.isFinite(item.timeoutSec) ? Number(item.timeoutSec) : Number.isFinite(item.timeout) ? Number(item.timeout) : 30)),
  };
}

function extractHooksObject(hooks, sourcePath) {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
  const result = [];
  let sequence = 0;
  for (const [eventName, entriesValue] of Object.entries(hooks)) {
    const entries = Array.isArray(entriesValue) ? entriesValue : [entriesValue];
    for (const group of entries) {
      const matcher = group && typeof group === 'object' && !Array.isArray(group) && group.matcher != null ? String(group.matcher) : '*';
      const items = group && typeof group === 'object' && !Array.isArray(group) && Array.isArray(group.hooks) ? group.hooks : [group];
      for (const item of items) {
        const command = commandFromHookItem(item);
        if (!command) continue;
        sequence += 1;
        const event = canonicalHookEvent(eventName);
        result.push({
          kind: 'hook',
          name: slugify(`${event}-${sequence}`),
          originalName: `${eventName}-${sequence}`,
          description: `Executable ${event} hook from ${sourcePath}`,
          event,
          matcher,
          ...command,
          sourcePath,
          namespace: namespaceForPath(sourcePath),
          executable: true,
          rank: sourceRank(sourcePath),
          contentHash: sha256(`${event}\0${matcher}\0${command.command}\0${command.commandWindows || ''}`),
        });
      }
    }
  }
  return result;
}

function extractConfig(json, sourcePath) {
  return {
    mcps: extractMcpServers(json, sourcePath),
    hooks: json?.hooks ? extractHooksObject(json.hooks, sourcePath) : [],
  };
}

function candidateConfig(relative) {
  const posix = toPosix(relative);
  const base = path.posix.basename(posix);
  if (/^\.github\/hooks\/[^/]+\.json$/i.test(posix)) return true;
  if (/^\.codex\/hooks\.json$/i.test(posix)) return true;
  if (!CONFIG_NAMES.has(base)) return false;
  if (base === 'settings.json') return posix.includes('/.claude/') || posix.startsWith('.claude/');
  if (base === 'mcp.json') return posix.includes('/.github/') || posix.startsWith('.github/') || posix.includes('/mcp/') || posix.startsWith('.codex/');
  return true;
}

async function listCurated(sourceRoot, limits) {
  const candidates = [];
  for (const [kind, directory] of Object.entries(CURATED_ROOTS)) {
    const absolute = path.join(sourceRoot, directory);
    if (!(await fileExists(absolute))) continue;
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    if (kind === 'skill') {
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const relative = toPosix(path.join(directory, entry.name, 'SKILL.md'));
        if (await fileExists(path.join(sourceRoot, relative))) candidates.push({ kind, relative });
      }
    } else {
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md') || /^(README|INDEX)\.md$/i.test(entry.name)) continue;
        candidates.push({ kind, relative: toPosix(path.join(directory, entry.name)) });
      }
    }
  }
  // Include relevant root/plugin configuration without indexing every markdown file.
  const files = await walkFiles(sourceRoot, {
    maxFiles: Math.min(limits.maxFiles, 75000),
    maxBytes: Math.min(limits.maxScanBytes, 512 * 1024 * 1024),
    maxDepth: Math.min(limits.maxDepth, 16),
    rejectSymlinks: false,
  });
  for (const file of files) {
    if (candidateConfig(file.relative) && (file.relative.startsWith('.') || file.relative.includes('/all-'))) {
      candidates.push({ kind: 'config', relative: file.relative });
    }
  }
  return candidates;
}

async function listAll(sourceRoot, limits) {
  const files = await walkFiles(sourceRoot, {
    maxFiles: limits.maxFiles,
    maxBytes: limits.maxScanBytes,
    maxDepth: limits.maxDepth,
    rejectSymlinks: false,
  });
  const candidates = [];
  for (const file of files) {
    const kind = inferKind(file.relative);
    if (kind) {
      if (/\/(?:README|INDEX)\.md$/i.test(`/${file.relative}`)) continue;
      candidates.push({ kind, relative: file.relative });
    } else if (candidateConfig(file.relative)) {
      candidates.push({ kind: 'config', relative: file.relative });
    }
  }
  return candidates;
}

function assignUniqueNames(items, warnings) {
  const byKind = new Map();
  const sorted = [...items].sort((a, b) => a.rank - b.rank || a.sourcePath.localeCompare(b.sourcePath));
  for (const item of sorted) {
    const names = byKind.get(item.kind) || new Map();
    byKind.set(item.kind, names);
    const existing = names.get(item.name);
    if (!existing) {
      names.set(item.name, item);
      continue;
    }
    if (existing.contentHash === item.contentHash) {
      item.duplicateOf = existing.sourcePath;
      continue;
    }
    const base = slugify(`${item.namespace}-${item.name}`);
    let candidate = base;
    let index = 2;
    while (names.has(candidate)) candidate = slugify(`${base}-${index++}`);
    warnings.push({
      code: 'RENAMED_COLLISION',
      kind: item.kind,
      source: item.sourcePath,
      message: `${item.kind} '${item.name}' collided with ${existing.sourcePath}; exported as '${candidate}'.`,
    });
    item.originalName = item.originalName || item.name;
    item.name = candidate;
    names.set(candidate, item);
  }
  return sorted.filter((item) => !item.duplicateOf);
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.kind}\0${candidate.relative}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.relative.localeCompare(b.relative) || a.kind.localeCompare(b.kind));
}

async function scanCatalog(sourceRoot, options = {}) {
  const absoluteRoot = await assertRootSafe(sourceRoot);
  const profile = options.profile || 'curated';
  if (!['curated', 'all'].includes(profile)) throw new Error(`Unknown scan profile: ${profile}`);
  const limits = {
    maxFileBytes: options.maxFileBytes ?? 2 * 1024 * 1024,
    maxSkillBytes: options.maxSkillBytes ?? 20 * 1024 * 1024,
    maxSkillFiles: options.maxSkillFiles ?? 2000,
    maxFiles: options.maxFiles ?? 100000,
    maxScanBytes: options.maxScanBytes ?? 1024 * 1024 * 1024,
    maxDepth: options.maxDepth ?? 32,
  };
  const candidates = dedupeCandidates(profile === 'all'
    ? await listAll(absoluteRoot, limits)
    : await listCurated(absoluteRoot, limits));
  const include = options.include || [];
  const exclude = options.exclude || [];
  const filtered = candidates.filter(({ relative }) => {
    if (include.length && !matchesAny(relative, include)) return false;
    if (exclude.length && matchesAny(relative, exclude)) return false;
    return true;
  });

  const entities = [];
  const mcps = [];
  const hooks = [];
  const warnings = [];
  const errors = [];

  for (const candidate of filtered) {
    try {
      if (candidate.kind === 'config') {
        const bytes = await readFileLimited(path.join(absoluteRoot, candidate.relative), limits.maxFileBytes);
        const text = bytes.toString('utf8');
        const parsed = candidate.relative.endsWith('.jsonc') ? parseJsonc(text) : JSON.parse(text.replace(/^\uFEFF/, ''));
        const extracted = extractConfig(parsed, candidate.relative);
        mcps.push(...extracted.mcps);
        hooks.push(...extracted.hooks);
        continue;
      }
      let entity = await readMarkdownEntity(absoluteRoot, candidate.relative, candidate.kind, limits);
      if (candidate.kind === 'skill') entity = await readSkillFiles(entity, limits);
      entities.push(entity);
      if (candidate.kind !== 'hook') continue;

      const command = entity.data.command || entity.data.bash;
      if (!command) {
        warnings.push({ code: 'HOOK_TEMPLATE_ONLY', source: entity.sourcePath, message: 'Markdown hook has no explicit command and is retained as documentation only.' });
        continue;
      }
      const eventValues = Array.isArray(entity.data.event) ? entity.data.event : String(entity.data.event || '').split(',').map((value) => value.trim()).filter(Boolean);
      for (const eventValue of eventValues.length ? eventValues : ['PostToolUse']) {
        hooks.push({
          ...entity,
          name: slugify(`${entity.name}-${canonicalHookEvent(eventValue)}`),
          event: canonicalHookEvent(eventValue),
          matcher: entity.data.matcher || '*',
          command: String(command),
          commandWindows: entity.data.powershell ? String(entity.data.powershell) : undefined,
          cwd: entity.data.cwd ? String(entity.data.cwd) : undefined,
          env: entity.data.env && typeof entity.data.env === 'object' && !Array.isArray(entity.data.env) ? entity.data.env : {},
          timeoutSec: Math.min(3600, Math.max(1, Number(entity.data.timeoutSec || entity.data.timeout || 30))),
          executable: true,
          contentHash: sha256(`${entity.contentHash}\0${canonicalHookEvent(eventValue)}`),
        });
      }
    } catch (error) {
      errors.push({ code: 'SCAN_ERROR', source: candidate.relative, message: error.message });
      if (options.strict) throw error;
    }
  }

  const uniqueEntities = assignUniqueNames(entities, warnings);
  const uniqueMcps = assignUniqueNames(mcps, warnings);
  const uniqueHooks = assignUniqueNames(hooks, warnings);
  const skills = uniqueEntities.filter((item) => item.kind === 'skill');
  const agents = uniqueEntities.filter((item) => item.kind === 'agent');
  const commands = uniqueEntities.filter((item) => item.kind === 'command');
  const hookTemplates = uniqueEntities.filter((item) => item.kind === 'hook');

  return {
    schemaVersion: 1,
    sourceRoot: absoluteRoot,
    sourceLabel: options.sourceLabel || path.basename(absoluteRoot) || 'source',
    profile,
    entities: uniqueEntities,
    skills,
    agents,
    commands,
    hookTemplates,
    hooks: uniqueHooks,
    mcps: uniqueMcps,
    warnings,
    errors,
    counts: {
      skills: skills.length,
      agents: agents.length,
      commands: commands.length,
      hookTemplates: hookTemplates.length,
      executableHooks: uniqueHooks.length,
      mcps: uniqueMcps.length,
    },
  };
}

module.exports = {
  CURATED_ROOTS,
  assignUniqueNames,
  candidateConfig,
  extractConfig,
  extractHooksObject,
  extractMcpServers,
  inferKind,
  ambiguousTimeoutIsMilliseconds,
  normalizeServer,
  normalizedTimeouts,
  numberField,
  scanCatalog,
};
