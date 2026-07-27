'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  BuildWithCliError, IGNORED_DIRECTORY_NAMES, IGNORED_FILE_NAMES,
  KIND_ORDER, MAX_SOURCE_FILE_BYTES, sha256,
} = require('./base');
const { parseFrontmatter, parseToolList } = require('./yaml');
const { fitSkillName, normalizeDescription, validateSkillName } = require('./names');

const CANONICAL_RESOURCE_ROOTS = Object.freeze({
  agent: path.join('plugins', 'all-agents', 'agents'),
  command: path.join('plugins', 'all-commands', 'commands'),
  skill: path.join('plugins', 'all-skills', 'skills'),
});

function resourceKindFromPath(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  if (/^plugins\/[^/]+\/agents\/[^/]+\.md$/.test(normalized)) {
    const base = path.posix.basename(normalized);
    return base === 'README.md' || base === 'INDEX.md' ? null : 'agent';
  }
  if (/^plugins\/[^/]+\/commands\/[^/]+\.md$/.test(normalized)) {
    const base = path.posix.basename(normalized);
    return base === 'README.md' || base === 'INDEX.md' ? null : 'command';
  }
  if (/^plugins\/[^/]+\/skills\/[^/]+\/SKILL\.md$/.test(normalized)) return 'skill';
  return null;
}

async function walkFiles(root, options = {}) {
  const output = [];
  async function visit(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (IGNORED_FILE_NAMES.has(entry.name)) continue;
      if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        if (options.rejectSymlinks !== false) {
          throw new BuildWithCliError(`Refusing to follow source symlink: ${absolute}`, {
            code: 'SOURCE_SYMLINK',
          });
        }
        continue;
      }
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output.push(absolute);
    }
  }
  await visit(root);
  return output;
}

async function isDirectory(candidate) {
  return Boolean((await fsp.stat(candidate).catch(() => null))?.isDirectory());
}

function candidateMatchesRoot(kind, resourceRoot, absolutePath) {
  const relative = path.relative(resourceRoot, absolutePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep);
  if (kind === 'skill') return segments.length === 2 && segments[1] === 'SKILL.md';
  if (segments.length !== 1 || path.extname(segments[0]) !== '.md') return false;
  return !['README.md', 'INDEX.md'].includes(segments[0]);
}

async function resourceRootsForKind(root, pluginsRoot, kind) {
  const canonical = path.join(root, CANONICAL_RESOURCE_ROOTS[kind]);
  if (await isDirectory(canonical)) return [canonical];

  const containerName = `${kind}s`;
  const entries = await fsp.readdir(pluginsRoot, { withFileTypes: true });
  const fallback = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.join(pluginsRoot, entry.name, containerName);
    if (await isDirectory(candidate)) fallback.push(candidate);
  }
  return fallback;
}

function sourcePreference(resource) {
  const normalized = resource.sourcePath.split(path.sep).join('/');
  let score = 0;
  if (normalized.includes('plugins/all-agents/agents/')) score += 1000;
  if (normalized.includes('plugins/all-commands/commands/')) score += 1000;
  if (normalized.includes('plugins/all-skills/skills/')) score += 1000;
  if (normalized.includes(`plugins/${resource.kind}s-`)) score += 500;
  score -= normalized.split('/').length;
  return score;
}

function inferResourceName(kind, parsed, absolutePath) {
  if (kind === 'agent' || kind === 'skill') {
    const configured = parsed.data.name;
    if (configured) return String(configured).trim();
  }
  if (kind === 'skill') return path.basename(path.dirname(absolutePath));
  return fitSkillName(path.basename(absolutePath, '.md'));
}

async function discoverUnsupported(root, pluginsRoot) {
  const unsupported = { hooks: 0, mcp: 0, plugins: 0 };
  const pluginFiles = await walkFiles(pluginsRoot, { rejectSymlinks: false });
  for (const absolutePath of pluginFiles) {
    const normalized = path.relative(root, absolutePath).split(path.sep).join('/');
    if (/\/hooks\//.test(normalized) || /hooks\.json$/i.test(normalized)) unsupported.hooks += 1;
    if (/\.claude-plugin\/plugin\.json$/i.test(normalized)) unsupported.plugins += 1;
    if (/\.mcp\.json$/i.test(normalized) || /\/mcp-servers?\//i.test(normalized)) unsupported.mcp += 1;
  }

  const mcpRoot = path.join(root, 'mcp-servers');
  if (await isDirectory(mcpRoot)) {
    unsupported.mcp += (await walkFiles(mcpRoot, { rejectSymlinks: false })).length;
  }
  const rootMcp = path.join(root, '.mcp.json');
  if ((await fsp.stat(rootMcp).catch(() => null))?.isFile()) unsupported.mcp += 1;
  return unsupported;
}

async function discoverCatalog(catalogRoot, options = {}) {
  const root = path.resolve(catalogRoot);
  const pluginsRoot = path.join(root, 'plugins');
  if (!await isDirectory(pluginsRoot)) {
    throw new BuildWithCliError(`Catalog does not contain a plugins directory: ${pluginsRoot}`, {
      code: 'CATALOG_NOT_FOUND',
    });
  }

  const candidates = [];
  const unsupported = await discoverUnsupported(root, pluginsRoot);

  for (const kind of ['agent', 'command', 'skill']) {
    const resourceRoots = await resourceRootsForKind(root, pluginsRoot, kind);
    for (const resourceRoot of resourceRoots) {
      const files = await walkFiles(resourceRoot);
      for (const absolutePath of files) {
        if (!candidateMatchesRoot(kind, resourceRoot, absolutePath)) continue;
        const relativePath = path.relative(root, absolutePath);
        const fileStat = await fsp.stat(absolutePath);
        if (fileStat.size > MAX_SOURCE_FILE_BYTES) {
          throw new BuildWithCliError(`Resource exceeds ${MAX_SOURCE_FILE_BYTES} bytes: ${relativePath}`, {
            code: 'SOURCE_TOO_LARGE',
          });
        }
        const raw = await fsp.readFile(absolutePath, 'utf8');
        const parsed = parseFrontmatter(raw, relativePath);
        const name = inferResourceName(kind, parsed, absolutePath);
        validateSkillName(name, kind);
        const description = normalizeDescription(parsed.data.description, `${name} ${kind}`);
        const tools = parseToolList(parsed.data.tools ?? parsed.data['allowed-tools']);
        const skillRoot = kind === 'skill' ? path.dirname(absolutePath) : null;
        const skillFiles = skillRoot ? await walkFiles(skillRoot) : null;
        candidates.push({
          kind,
          name,
          description,
          category: parsed.data.category ? String(parsed.data.category) : 'uncategorized',
          argumentHint: parsed.data['argument-hint'] ? String(parsed.data['argument-hint']) : undefined,
          tools,
          model: parsed.data.model ? String(parsed.data.model) : undefined,
          license: parsed.data.license ? String(parsed.data.license) : undefined,
          sourcePath: relativePath,
          absolutePath,
          skillRoot,
          skillFiles,
          raw,
          body: parsed.body,
          frontmatter: parsed.data,
          contentHash: sha256(raw),
        });
      }
    }
  }

  const groups = new Map();
  for (const resource of candidates) {
    const key = `${resource.kind}:${resource.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(resource);
  }

  const resources = [];
  const warnings = [];
  const conflicts = [];
  for (const [key, group] of groups.entries()) {
    group.sort((left, right) => {
      const rankDiff = sourcePreference(right) - sourcePreference(left);
      return rankDiff || left.sourcePath.localeCompare(right.sourcePath);
    });
    const selected = group[0];
    resources.push(selected);
    if (group.length > 1) {
      const hashes = new Set(group.map((entry) => entry.contentHash));
      const duplicate = {
        key,
        selected: selected.sourcePath,
        alternatives: group.slice(1).map((entry) => entry.sourcePath),
        identical: hashes.size === 1,
      };
      if (duplicate.identical) warnings.push(duplicate);
      else conflicts.push(duplicate);
    }
  }

  resources.sort((left, right) => {
    const kindDiff = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
    return kindDiff || left.name.localeCompare(right.name);
  });

  if (options.strict && conflicts.length > 0) {
    throw new BuildWithCliError(`Catalog contains ${conflicts.length} conflicting duplicate resource name(s)`, {
      code: 'CATALOG_CONFLICT',
      details: conflicts,
    });
  }

  return { root, resources, warnings, conflicts, unsupported };
}

function globToRegExp(pattern) {
  let source = '^';
  for (const char of pattern) {
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  source += '$';
  return new RegExp(source);
}

function selectorMatches(resource, selector) {
  const trimmed = selector.trim();
  if (!trimmed || trimmed === '*') return true;
  const separator = trimmed.indexOf(':');
  let kindPattern = '*';
  let namePattern = trimmed;
  if (separator > 0) {
    kindPattern = trimmed.slice(0, separator);
    namePattern = trimmed.slice(separator + 1) || '*';
  }
  return globToRegExp(kindPattern).test(resource.kind) && globToRegExp(namePattern).test(resource.name);
}

function selectResources(resources, selectors = [], options = {}) {
  const includeSelectors = selectors.length ? selectors : ['*'];
  const excludeSelectors = options.exclude || [];
  const kinds = options.kinds?.length ? new Set(options.kinds) : null;
  return resources.filter((resource) => {
    if (kinds && !kinds.has(resource.kind)) return false;
    if (!includeSelectors.some((selector) => selectorMatches(resource, selector))) return false;
    if (excludeSelectors.some((selector) => selectorMatches(resource, selector))) return false;
    return true;
  });
}

module.exports = {
  CANONICAL_RESOURCE_ROOTS, resourceKindFromPath, walkFiles, discoverCatalog,
  selectResources, selectorMatches, globToRegExp,
};
