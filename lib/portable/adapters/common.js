'use strict';

const path = require('node:path');
const { generationTimestamp, slugify, stableStringify, toPosix } = require('../util');
const { renderSkill, skillFromAgent, skillFromCommand } = require('../normalize');

function addFile(files, relative, content, source = null, mode = 0o644) {
  const normalized = toPosix(relative).replace(/^\.\//, '');
  if (files.has(normalized)) throw new Error(`Adapter generated duplicate path: ${normalized}`);
  files.set(normalized, { content, source, mode });
}

function addSkillBundle(files, entity, destinationRoot, target) {
  const bundle = entity.bundle || [];
  for (const file of bundle) {
    const destination = path.posix.join(destinationRoot, entity.name, file.relative);
    addFile(files, destination, file.relative === 'SKILL.md' ? renderSkill(entity, target) : file.content, entity.sourcePath, file.mode || 0o644);
  }
  if (!bundle.some((file) => file.relative === 'SKILL.md')) {
    addFile(files, path.posix.join(destinationRoot, entity.name, 'SKILL.md'), renderSkill(entity, target), entity.sourcePath);
  }
}

function chooseConvertedName(files, destinationRoot, preferred, entity, warnings) {
  let name = preferred;
  let candidate = path.posix.join(destinationRoot, name, 'SKILL.md');
  if (!files.has(candidate)) return name;
  const base = slugify(`${entity.namespace || entity.kind}-${preferred}`);
  name = base;
  let index = 2;
  candidate = path.posix.join(destinationRoot, name, 'SKILL.md');
  while (files.has(candidate)) {
    name = slugify(`${base}-${index++}`);
    candidate = path.posix.join(destinationRoot, name, 'SKILL.md');
  }
  warnings?.push({
    code: 'CONVERTED_SKILL_RENAMED',
    source: entity.sourcePath,
    message: `Converted ${entity.kind} skill '${preferred}' collided with an existing skill and was exported as '${name}'.`,
  });
  return name;
}

function addConvertedSkills(files, catalog, destinationRoot, target, options = {}) {
  const warnings = options.warnings || [];
  if (options.agents !== false) {
    for (const entity of catalog.agents) {
      const preferred = slugify(`agent-${entity.name}`);
      const name = chooseConvertedName(files, destinationRoot, preferred, entity, warnings);
      const converted = skillFromAgent(entity, target, { name, frontmatter: options.agentFrontmatter });
      addFile(files, path.posix.join(destinationRoot, name, 'SKILL.md'), converted.content, entity.sourcePath);
    }
  }
  if (options.commands !== false) {
    for (const entity of catalog.commands) {
      const preferred = slugify(`command-${entity.name}`);
      const name = chooseConvertedName(files, destinationRoot, preferred, entity, warnings);
      const converted = skillFromCommand(entity, target, {
        name,
        includeInvocationFields: options.includeInvocationFields,
        frontmatter: options.commandFrontmatter,
      });
      addFile(files, path.posix.join(destinationRoot, name, 'SKILL.md'), converted.content, entity.sourcePath);
    }
  }
}

function containsEnvironmentReference(value) {
  return /(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|(?:^|[^$A-Za-z0-9_])\$[A-Za-z_][A-Za-z0-9_]*|\{env:[A-Za-z_][A-Za-z0-9_]*\})/.test(String(value || ''));
}

function mcpSecurityWarnings(catalog) {
  const warnings = [];
  const sensitiveName = /(?:authorization|api[-_]?key|token|secret|password|credential)/i;
  for (const server of catalog.mcps || []) {
    for (const [name, value] of Object.entries(server.headers || {})) {
      if (sensitiveName.test(name) && !containsEnvironmentReference(value)) warnings.push({
        code: 'LITERAL_MCP_SECRET',
        source: server.sourcePath,
        message: `MCP server '${server.name}' has a literal sensitive header '${name}'. Replace it with an environment reference before committing generated output.`,
      });
    }
    for (const [name, value] of Object.entries(server.env || {})) {
      if (sensitiveName.test(name) && !containsEnvironmentReference(value)) warnings.push({
        code: 'LITERAL_MCP_SECRET',
        source: server.sourcePath,
        message: `MCP server '${server.name}' has a literal value for sensitive environment key '${name}'. Replace it with an environment reference before committing generated output.`,
      });
    }
  }
  return warnings;
}

function sortIssues(items) {
  const unique = [];
  const seen = new Set();
  for (const item of items) {
    const key = `${item.code || ''}\0${item.source || ''}\0${item.message || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique.sort((a, b) =>
    String(a.code || '').localeCompare(String(b.code || '')) ||
    String(a.source || '').localeCompare(String(b.source || '')) ||
    String(a.message || '').localeCompare(String(b.message || '')));
}

function capabilityReport(target, catalog, adapter, warnings = [], degradations = [], options = {}) {
  const stamp = generationTimestamp(options.stamp);
  return {
    schemaVersion: 1,
    target,
    ...(stamp ? { generatedAt: stamp } : {}),
    source: catalog.sourceLabel,
    sourceProfile: catalog.profile,
    sourceCounts: catalog.counts,
    capabilities: adapter.capabilities,
    warnings: sortIssues([...catalog.warnings, ...mcpSecurityWarnings(catalog), ...warnings]),
    errors: sortIssues(catalog.errors),
    degradations: sortIssues(degradations),
  };
}

function reportMarkdown(report) {
  const lines = [`# BuildWithCLI portability report: ${report.target}`, ''];
  if (report.generatedAt) lines.push(`Generated: ${report.generatedAt}`, '');
  lines.push(`Source: ${report.source}`, '', '## Source inventory', '', '| Kind | Count |', '|---|---:|');
  for (const [key, value] of Object.entries(report.sourceCounts)) lines.push(`| ${key} | ${value} |`);
  lines.push('', '## Target capabilities', '', '| Capability | Native | Strategy |', '|---|:---:|---|');
  for (const [name, value] of Object.entries(report.capabilities)) {
    lines.push(`| ${name} | ${value.native ? 'yes' : 'no'} | ${value.strategy} |`);
  }
  lines.push('', '## Fidelity notes', '');
  if (!report.degradations.length) lines.push('No known semantic degradations were introduced.');
  else for (const item of report.degradations) lines.push(`- **${item.code}** — ${item.message}`);
  lines.push('', '## Warnings', '');
  if (!report.warnings.length) lines.push('No warnings.');
  else for (const item of report.warnings) lines.push(`- **${item.code || 'WARNING'}**${item.source ? ` (${item.source})` : ''} — ${item.message}`);
  if (report.errors.length) {
    lines.push('', '## Scan errors', '');
    for (const item of report.errors) lines.push(`- **${item.code || 'ERROR'}**${item.source ? ` (${item.source})` : ''} — ${item.message}`);
  }
  return lines.join('\n') + '\n';
}

function finalize(files, target, catalog, adapter, warnings = [], degradations = [], options = {}) {
  const report = capabilityReport(target, catalog, adapter, warnings, degradations, options);
  addFile(files, 'PORTABILITY_REPORT.json', stableStringify(report));
  addFile(files, 'PORTABILITY_REPORT.md', reportMarkdown(report));
  addFile(files, 'README.md', [
    `# BuildWithCLI export for ${adapter.displayName || target}`,
    '',
    `Source catalog: ${catalog.sourceLabel}`,
    '',
    'Review `PORTABILITY_REPORT.md` before installation. Executable hooks are excluded unless compilation used both `--hooks trusted` and `--trust-hooks`.',
    '',
  ].join('\n'));
  return { files, report };
}

function mcpStandardObject(server) {
  const value = {};
  if (server.url) {
    value.url = server.url;
    if (Object.keys(server.headers || {}).length) value.headers = server.headers;
    if (Object.keys(server.envHeaders || {}).length) value.env_http_headers = server.envHeaders;
    if (server.bearerTokenEnvVar) value.bearer_token_env_var = server.bearerTokenEnvVar;
  } else {
    value.command = server.command;
    if (server.args?.length) value.args = server.args;
    if (server.cwd) value.cwd = server.cwd;
    if (Object.keys(server.env || {}).length) value.env = server.env;
  }
  if (server.startupTimeoutSec != null) value.startup_timeout_sec = server.startupTimeoutSec;
  if (server.toolTimeoutSec != null) value.tool_timeout_sec = server.toolTimeoutSec;
  if (server.enabled === false) value.disabled = true;
  return value;
}

function mcpStandardConfig(catalog) {
  return { mcpServers: Object.fromEntries(catalog.mcps.map((server) => [server.name, mcpStandardObject(server)])) };
}

module.exports = {
  addConvertedSkills,
  addFile,
  addSkillBundle,
  capabilityReport,
  finalize,
  containsEnvironmentReference,
  mcpSecurityWarnings,
  mcpStandardConfig,
  mcpStandardObject,
  reportMarkdown,
};
