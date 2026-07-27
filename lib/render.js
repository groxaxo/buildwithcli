'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  BuildWithCliError, KIND_ORDER, MAX_COPILOT_AGENT_PROMPT,
  MAX_SOURCE_FILE_BYTES, normalizeNewlines,
} = require('./base');
const { stringifyFrontmatter } = require('./yaml');
const {
  OPENCODE_TOOL_MAP, COPILOT_TOOL_MAP, mapTools, normalizeDescription,
  compactHermesDescription, validateSkillName, fitSkillName,
} = require('./names');
const { formatUsesSkillNamespace, resolveFormatRoot } = require('./targets');

function titleFromSlug(name) {
  return name.split('-').map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part).join(' ');
}

function ordinalWord(number) {
  return ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'][number] || `${number}th`;
}

function rewriteCommandArguments(body) {
  return normalizeNewlines(body)
    .replace(/\$\{?ARGUMENTS\}?/g, 'the complete arguments supplied with this invocation')
    .replace(/\$(\d+)/g, (_, number) => `the ${ordinalWord(Number(number))} supplied argument`);
}

function convertedSkillBody(resource) {
  const sourceLabel = resource.kind === 'command' ? 'command' : 'specialist agent';
  let instructions = resource.kind === 'command' ? rewriteCommandArguments(resource.body) : resource.body;
  instructions = instructions.replace(/^#\s+Claude Command:\s*/im, '# ');
  const invocationNote = resource.kind === 'command'
    ? '\n\n## Invocation input\n\nTreat the text supplied after this skill name as the command input. Preserve the original workflow and verify all changes before reporting success.'
    : '';
  return `# ${titleFromSlug(resource.name)}\n\n## When to use\n\n${resource.description}\n\n## Operating instructions\n\nThis skill was projected from the BuildWithCLI ${sourceLabel} \`${resource.name}\`. Follow the procedure below as the authoritative operating instructions.\n\n${instructions.trim()}${invocationNote}\n`;
}

function sourceMetadata(resource) {
  return {
    source: resource.sourcePath.split(path.sep).join('/'),
    original_kind: resource.kind,
    generated_by: 'buildwithcli',
  };
}

function buildSkillFrontmatter(resource, outputName, format) {
  const isConverted = resource.kind !== 'skill';
  const description = normalizeDescription(resource.description, `${outputName} instructions`);
  const data = {
    name: outputName,
    description: format === 'hermes-skill' ? compactHermesDescription(description) : description,
  };
  if (resource.license) data.license = resource.license;

  if (format === 'opencode-skill') {
    data.compatibility = 'OpenCode';
    data.metadata = sourceMetadata(resource);
  } else if (format === 'hermes-skill') {
    data.version = '1.0.0';
    data.metadata = {
      hermes: {
        tags: ['buildwithcli', resource.kind],
        category: resource.category || 'uncategorized',
      },
    };
  } else if (format === 'codex-skill') {
    data.metadata = {
      'short-description': compactHermesDescription(description),
      ...sourceMetadata(resource),
    };
  } else if (format === 'copilot-skill') {
    if (resource.argumentHint) data['argument-hint'] = resource.argumentHint;
    if (resource.tools !== null) {
      const mapped = mapTools(resource.tools, COPILOT_TOOL_MAP, { preserveUnknown: true });
      data['allowed-tools'] = mapped.mapped;
    }
    data['user-invocable'] = true;
    if (resource.kind === 'command') data['disable-model-invocation'] = true;
    data.metadata = sourceMetadata(resource);
  } else if (format === 'claude-skill') {
    if (resource.tools !== null) data['allowed-tools'] = resource.tools;
    data.metadata = sourceMetadata(resource);
  } else {
    data.compatibility = 'Agent Skills open standard';
    data.metadata = sourceMetadata(resource);
  }

  if (isConverted && resource.kind === 'command' && !data['argument-hint']) {
    data['argument-hint'] = resource.argumentHint || '[arguments]';
  }
  return data;
}

function renderSkillMain(resource, outputName, format) {
  validateSkillName(outputName, 'output skill');
  const body = resource.kind === 'skill' ? resource.body : convertedSkillBody(resource);
  return stringifyFrontmatter(buildSkillFrontmatter(resource, outputName, format), body);
}

function renderOpenCodeAgent(resource) {
  const data = {
    description: resource.description,
    mode: 'subagent',
  };
  const warnings = [];
  if (resource.tools !== null) {
    const mapped = mapTools(resource.tools, OPENCODE_TOOL_MAP);
    data.permission = { '*': 'deny' };
    for (const tool of mapped.mapped) data.permission[tool] = 'allow';
    if (mapped.unknown.length) warnings.push(`Unmapped OpenCode tools: ${mapped.unknown.join(', ')}`);
  }
  return { content: stringifyFrontmatter(data, resource.body), warnings };
}

function renderOpenCodeCommand(resource) {
  const data = { description: resource.description };
  const warnings = [];
  if (resource.tools !== null) {
    const mapped = mapTools(resource.tools, OPENCODE_TOOL_MAP);
    if (mapped.unknown.length) warnings.push(`Unmapped OpenCode tools: ${mapped.unknown.join(', ')}`);
    warnings.push('OpenCode command files do not carry per-command permissions; the active agent permission policy applies.');
  }
  return { content: stringifyFrontmatter(data, resource.body), warnings };
}

function renderCopilotAgent(resource) {
  if (resource.body.length > MAX_COPILOT_AGENT_PROMPT) {
    throw new BuildWithCliError(
      `Copilot agent '${resource.name}' exceeds the ${MAX_COPILOT_AGENT_PROMPT}-character prompt limit`,
      { code: 'COPILOT_AGENT_TOO_LARGE' },
    );
  }
  const data = {
    name: resource.name,
    description: resource.description,
  };
  const warnings = [];
  if (resource.tools !== null) {
    const mapped = mapTools(resource.tools, COPILOT_TOOL_MAP, { preserveUnknown: true });
    data.tools = mapped.mapped;
    if (mapped.unknown.length) warnings.push(`Copilot will ignore unrecognized tools: ${mapped.unknown.join(', ')}`);
  }
  data.metadata = sourceMetadata(resource);
  return { content: stringifyFrontmatter(data, resource.body), warnings };
}

function renderCopilotCommand(resource) {
  const data = { description: resource.description };
  if (resource.argumentHint) data['argument-hint'] = resource.argumentHint;
  const warnings = [];
  if (resource.tools !== null) {
    const mapped = mapTools(resource.tools, COPILOT_TOOL_MAP, { preserveUnknown: true });
    data['allowed-tools'] = mapped.mapped;
    if (mapped.unknown.length) warnings.push(`Copilot will ignore unrecognized tools: ${mapped.unknown.join(', ')}`);
  }
  data['disable-model-invocation'] = true;
  return { content: stringifyFrontmatter(data, resource.body), warnings };
}

function renderSharedCommand(resource) {
  const data = { description: resource.description };
  if (resource.argumentHint) data['argument-hint'] = resource.argumentHint;
  if (resource.tools !== null) data['allowed-tools'] = resource.tools;
  return { content: stringifyFrontmatter(data, resource.body), warnings: [] };
}

function renderNativeResource(resource, format) {
  if (format === 'opencode-agent') return renderOpenCodeAgent(resource);
  if (format === 'opencode-command') return renderOpenCodeCommand(resource);
  if (format === 'copilot-agent') return renderCopilotAgent(resource);
  if (format === 'copilot-command') return renderCopilotCommand(resource);
  if (format === 'shared-command') return renderSharedCommand(resource);
  if (format === 'claude-native') return { content: resource.raw, warnings: [] };
  throw new BuildWithCliError(`Unsupported native format: ${format}`, { code: 'UNSUPPORTED_FORMAT' });
}

function allocateOutputNames(selectedResources, target, scope, context) {
  const allocations = new Map();
  const used = new Map();
  const sorted = [...selectedResources].sort((left, right) => {
    const kindDiff = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
    return kindDiff || left.name.localeCompare(right.name);
  });

  for (const resource of sorted) {
    const { format, namespace } = resolveFormatRoot(target, scope, resource.kind, context);
    if (!formatUsesSkillNamespace(format)) {
      allocations.set(`${resource.kind}:${resource.name}`, resource.name);
      continue;
    }
    if (!used.has(namespace)) used.set(namespace, new Set());
    const namespaceNames = used.get(namespace);
    let candidate = fitSkillName(resource.name);
    if (namespaceNames.has(candidate)) candidate = fitSkillName(`${resource.kind}-${resource.name}`);
    let suffix = 2;
    const base = candidate;
    while (namespaceNames.has(candidate)) {
      candidate = fitSkillName(`${base}-${suffix}`);
      suffix += 1;
    }
    validateSkillName(candidate, 'output skill');
    namespaceNames.add(candidate);
    allocations.set(`${resource.kind}:${resource.name}`, candidate);
  }
  return allocations;
}

function outputFileName(resource, format, outputName) {
  if (formatUsesSkillNamespace(format)) return path.join(outputName, 'SKILL.md');
  if (format === 'copilot-agent') return `${outputName}.agent.md`;
  return `${outputName}.md`;
}

async function sourceSupportFiles(resource) {
  if (resource.kind !== 'skill' || !resource.skillFiles) return [];
  const support = [];
  const canonicalSkillRoot = await fsp.realpath(resource.skillRoot);
  for (const absolute of resource.skillFiles) {
    if (path.resolve(absolute) === path.resolve(resource.absolutePath)) continue;
    const stat = await fsp.lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new BuildWithCliError(`Skill support path must remain a regular file: ${absolute}`, {
        code: stat.isSymbolicLink() ? 'SOURCE_SYMLINK' : 'INVALID_SOURCE_FILE',
      });
    }
    const canonicalSource = await fsp.realpath(absolute);
    if (!isPathInside(canonicalSkillRoot, canonicalSource)) {
      throw new BuildWithCliError(`Skill support file resolves outside its root: ${absolute}`, {
        code: 'UNSAFE_SOURCE_PATH',
      });
    }
    if (stat.size > MAX_SOURCE_FILE_BYTES) {
      throw new BuildWithCliError(`Skill support file exceeds ${MAX_SOURCE_FILE_BYTES} bytes: ${absolute}`, {
        code: 'SOURCE_TOO_LARGE',
      });
    }
    const relative = path.relative(resource.skillRoot, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new BuildWithCliError(`Skill support file escapes its root: ${absolute}`, {
        code: 'UNSAFE_SOURCE_PATH',
      });
    }
    support.push({ relative, content: await fsp.readFile(absolute), mode: stat.mode & 0o777 });
  }
  return support;
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function canonicalPotentialPath(candidate) {
  const resolved = path.resolve(candidate);
  const missing = [];
  let current = resolved;

  while (true) {
    const stat = await fsp.lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat) {
      const real = await fsp.realpath(current);
      return path.resolve(real, ...missing);
    }
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    missing.unshift(path.basename(current));
    current = parent;
  }
}

async function assertNoSymlinkTraversal(root, destination, boundaryRoot = null) {
  const resolvedRoot = path.resolve(root);
  const resolvedDestination = path.resolve(destination);
  if (!isPathInside(resolvedRoot, resolvedDestination)) {
    throw new BuildWithCliError(`Destination escapes allowed root: ${destination}`, {
      code: 'UNSAFE_DESTINATION',
    });
  }

  const [canonicalRoot, canonicalDestination] = await Promise.all([
    canonicalPotentialPath(resolvedRoot),
    canonicalPotentialPath(resolvedDestination),
  ]);
  if (!isPathInside(canonicalRoot, canonicalDestination)) {
    throw new BuildWithCliError(`Destination resolves outside its target root through a symlink: ${destination}`, {
      code: 'DESTINATION_SYMLINK_ESCAPE',
      details: { root: canonicalRoot, destination: canonicalDestination },
    });
  }
  if (boundaryRoot) {
    const canonicalBoundary = await canonicalPotentialPath(boundaryRoot);
    if (!isPathInside(canonicalBoundary, canonicalRoot)) {
      throw new BuildWithCliError(`Target root resolves outside its allowed boundary: ${root}`, {
        code: 'TARGET_ROOT_SYMLINK_ESCAPE',
        details: { boundary: canonicalBoundary, root: canonicalRoot },
      });
    }
  }

  const destinationStat = await fsp.lstat(resolvedDestination).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (destinationStat?.isSymbolicLink()) {
    throw new BuildWithCliError(`Refusing to replace symlink: ${resolvedDestination}`, {
      code: 'DESTINATION_SYMLINK',
    });
  }
}

async function buildProjectionPlan({ resources, targetIds, targets, scope, context }) {
  const operationsByDestination = new Map();
  const warnings = [];
  const targetNotes = [];

  for (const targetId of targetIds) {
    const target = targets[targetId];
    const allocations = allocateOutputNames(resources, target, scope, context);
    const scopeNotes = target[scope]?.notes || [];
    for (const note of [...(target.notes || []), ...scopeNotes]) {
      targetNotes.push({ target: targetId, note });
    }

    for (const resource of resources) {
      const { format, root } = resolveFormatRoot(target, scope, resource.kind, context);
      const outputName = allocations.get(`${resource.kind}:${resource.name}`);
      const relativeMain = outputFileName(resource, format, outputName);
      const destination = path.resolve(root, relativeMain);
      if (!isPathInside(root, destination)) {
        throw new BuildWithCliError(`Projected path escapes target root: ${destination}`, {
          code: 'UNSAFE_DESTINATION',
        });
      }

      let rendered;
      if (formatUsesSkillNamespace(format)) {
        rendered = { content: renderSkillMain(resource, outputName, format), warnings: [] };
      } else {
        rendered = renderNativeResource(resource, format);
      }
      for (const warning of rendered.warnings) {
        warnings.push({ target: targetId, resource: `${resource.kind}:${resource.name}`, warning });
      }

      const mainOperation = {
        targetIds: [targetId],
        sourceKind: resource.kind,
        sourceName: resource.name,
        outputName,
        sourcePath: resource.sourcePath,
        root,
        boundaryRoot: scope === 'project' ? context.projectRoot : null,
        scope,
        destination,
        content: Buffer.from(rendered.content, 'utf8'),
        mode: 0o644,
        format,
      };
      mergeProjectionOperation(operationsByDestination, mainOperation);

      if (formatUsesSkillNamespace(format) && resource.kind === 'skill') {
        for (const support of await sourceSupportFiles(resource)) {
          const supportDestination = path.resolve(root, outputName, support.relative);
          if (!isPathInside(path.resolve(root, outputName), supportDestination)) {
            throw new BuildWithCliError(`Skill support path escapes target directory: ${support.relative}`, {
              code: 'UNSAFE_DESTINATION',
            });
          }
          mergeProjectionOperation(operationsByDestination, {
            ...mainOperation,
            destination: supportDestination,
            content: support.content,
            mode: support.mode,
            supportFile: true,
          });
        }
      }
    }
  }

  return {
    operations: [...operationsByDestination.values()].sort((left, right) => left.destination.localeCompare(right.destination)),
    warnings,
    targetNotes: dedupeObjects(targetNotes, (entry) => `${entry.target}:${entry.note}`),
  };
}

function mergeProjectionOperation(map, operation) {
  const existing = map.get(operation.destination);
  if (!existing) {
    map.set(operation.destination, operation);
    return;
  }
  if (!existing.content.equals(operation.content) || existing.mode !== operation.mode) {
    throw new BuildWithCliError(
      `Targets project different content to the same path: ${operation.destination}`,
      {
        code: 'PROJECTION_COLLISION',
        details: {
          existing: { targets: existing.targetIds, source: existing.sourcePath, format: existing.format },
          incoming: { targets: operation.targetIds, source: operation.sourcePath, format: operation.format },
        },
      },
    );
  }
  for (const targetId of operation.targetIds) {
    if (!existing.targetIds.includes(targetId)) existing.targetIds.push(targetId);
  }
}

function dedupeObjects(values, keyFn) {
  const seen = new Set();
  return values.filter((value) => {
    const key = keyFn(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  rewriteCommandArguments, renderSkillMain, renderOpenCodeAgent,
  renderOpenCodeCommand, renderCopilotAgent, renderCopilotCommand,
  renderSharedCommand, buildProjectionPlan, mergeProjectionOperation,
  isPathInside, canonicalPotentialPath, assertNoSymlinkTraversal,
  dedupeObjects,
};
