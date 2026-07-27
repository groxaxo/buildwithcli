'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { BuildWithCliError, TARGETS, isPlainObject } = require('./base');
const { validateSkillName } = require('./names');

function expandEnvironmentTemplate(template, environment = process.env, home = os.homedir()) {
  let expanded = template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]+)\}/g, (_, key, fallback) => {
    return environment[key] || fallback;
  });
  expanded = expanded.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => environment[key] || '');
  if (expanded === '~') expanded = home;
  else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) expanded = path.join(home, expanded.slice(2));
  return expanded;
}

function normalizeTargetDefinition(raw, source = '<custom profile>') {
  if (!isPlainObject(raw)) {
    throw new BuildWithCliError(`Target profile must be an object: ${source}`, { code: 'INVALID_TARGET_PROFILE' });
  }
  const id = String(raw.id || '').trim();
  validateSkillName(id, 'target');
  const profile = {
    id,
    displayName: String(raw.displayName || id),
    binaries: Array.isArray(raw.binaries) ? raw.binaries.map(String) : raw.binary ? [String(raw.binary)] : [],
    project: raw.project,
    user: raw.user,
    notes: Array.isArray(raw.notes) ? raw.notes.map(String) : [],
    custom: true,
  };
  let supportedScopes = 0;
  for (const scope of ['project', 'user']) {
    const config = profile[scope];
    if (config === undefined || config === null) continue;
    supportedScopes += 1;
    if (!isPlainObject(config) || !isPlainObject(config.roots) || !isPlainObject(config.formats)) {
      throw new BuildWithCliError(`Target profile ${id}.${scope} requires roots and formats objects`, {
        code: 'INVALID_TARGET_PROFILE',
      });
    }
    let supportedKinds = 0;
    for (const kind of ['agent', 'command', 'skill']) {
      const format = config.formats[kind];
      if (!format) continue;
      supportedKinds += 1;
      if (!SUPPORTED_FORMATS.has(format)) {
        throw new BuildWithCliError(`Unsupported target format '${format}' in ${source}`, {
          code: 'INVALID_TARGET_PROFILE',
        });
      }
      const rootKey = formatUsesSkillNamespace(format) ? 'skill' : kind;
      if (!config.roots[rootKey]) {
        throw new BuildWithCliError(`Target profile ${id}.${scope} is missing roots.${rootKey}`, {
          code: 'INVALID_TARGET_PROFILE',
        });
      }
    }
    if (supportedKinds === 0) {
      throw new BuildWithCliError(`Target profile ${id}.${scope} does not define any formats`, {
        code: 'INVALID_TARGET_PROFILE',
      });
    }
  }
  if (supportedScopes === 0) {
    throw new BuildWithCliError(`Target profile ${id} must define project and/or user scope`, {
      code: 'INVALID_TARGET_PROFILE',
    });
  }
  return profile;
}

const SUPPORTED_FORMATS = new Set([
  'portable-skill',
  'opencode-skill',
  'hermes-skill',
  'codex-skill',
  'copilot-skill',
  'claude-skill',
  'opencode-agent',
  'opencode-command',
  'copilot-agent',
  'copilot-command',
  'shared-command',
  'claude-native',
]);

async function loadTargetProfiles(files = []) {
  const targets = { ...TARGETS };
  for (const file of files) {
    const absolute = path.resolve(file);
    const parsed = JSON.parse(await fsp.readFile(absolute, 'utf8'));
    const definitions = Array.isArray(parsed) ? parsed : Array.isArray(parsed.targets) ? parsed.targets : [parsed];
    for (const definition of definitions) {
      const profile = normalizeTargetDefinition(definition, absolute);
      if (targets[profile.id]) {
        throw new BuildWithCliError(`Target '${profile.id}' is already defined`, {
          code: 'DUPLICATE_TARGET',
        });
      }
      targets[profile.id] = profile;
    }
  }
  return targets;
}

function findExecutable(binary, environment = process.env) {
  const pathValue = environment.PATH || environment.Path || environment.path || '';
  const extensions = process.platform === 'win32'
    ? (environment.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, process.platform === 'win32' ? `${binary}${extension}` : binary);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111))) return candidate;
      } catch {
        // Continue searching.
      }
    }
  }
  return null;
}

function resolveRequestedTargets(requested, targets, environment = process.env) {
  const values = requested.flatMap((value) => String(value).split(',')).map((value) => value.trim()).filter(Boolean);
  const targetNames = values.length ? values : ['auto'];
  const resolved = [];
  for (const name of targetNames) {
    if (name === 'all') {
      for (const id of Object.keys(targets)) if (!resolved.includes(id)) resolved.push(id);
      continue;
    }
    if (name === 'auto') {
      const detected = Object.values(targets)
        .filter((target) => target.binaries.some((binary) => findExecutable(binary, environment)))
        .map((target) => target.id);
      for (const id of detected.length ? detected : ['agents']) if (!resolved.includes(id)) resolved.push(id);
      continue;
    }
    if (!targets[name]) {
      throw new BuildWithCliError(`Unknown target '${name}'. Run 'buildwithcli targets' to list targets.`, {
        code: 'UNKNOWN_TARGET',
      });
    }
    if (!resolved.includes(name)) resolved.push(name);
  }
  return resolved;
}

function assertRelativeProjectRoot(value, targetId, kind) {
  if (path.isAbsolute(value)) {
    throw new BuildWithCliError(`Project root for ${targetId}.${kind} must be relative: ${value}`, {
      code: 'UNSAFE_TARGET_ROOT',
    });
  }
  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new BuildWithCliError(`Project root escapes the project: ${value}`, {
      code: 'UNSAFE_TARGET_ROOT',
    });
  }
  return normalized;
}

function resolveRootTemplate(value, scope, context, targetId, kind) {
  if (!value) return null;
  const expanded = expandEnvironmentTemplate(String(value), context.environment, context.home);
  if (scope === 'project') {
    const relative = assertRelativeProjectRoot(expanded, targetId, kind);
    return path.resolve(context.projectRoot, relative);
  }
  return path.resolve(expanded);
}

function formatUsesSkillNamespace(format) {
  return format.endsWith('-skill') || format === 'portable-skill';
}

function resolveFormatRoot(target, scope, resourceKind, context) {
  const scopeConfig = target[scope];
  if (!scopeConfig) {
    throw new BuildWithCliError(`Target '${target.id}' does not support ${scope} scope`, {
      code: 'UNSUPPORTED_SCOPE',
    });
  }
  const format = scopeConfig.formats[resourceKind];
  if (!format) {
    throw new BuildWithCliError(`Target '${target.id}' does not support ${resourceKind} resources`, {
      code: 'UNSUPPORTED_RESOURCE',
    });
  }
  const rootKey = formatUsesSkillNamespace(format) ? 'skill' : resourceKind;
  const rootTemplate = scopeConfig.roots[rootKey];
  if (!rootTemplate) {
    throw new BuildWithCliError(`Target '${target.id}' has no ${rootKey} root for ${scope} scope`, {
      code: 'INVALID_TARGET_PROFILE',
    });
  }
  return {
    format,
    root: resolveRootTemplate(rootTemplate, scope, context, target.id, rootKey),
    namespace: `${path.resolve(resolveRootTemplate(rootTemplate, scope, context, target.id, rootKey))}|${rootKey}`,
  };
}

module.exports = {
  SUPPORTED_FORMATS, expandEnvironmentTemplate, normalizeTargetDefinition,
  loadTargetProfiles, findExecutable, resolveRequestedTargets,
  assertRelativeProjectRoot, resolveRootTemplate, formatUsesSkillNamespace,
  resolveFormatRoot,
};
