'use strict';

const {
  BuildWithCliError, MAX_SKILL_DESCRIPTION, MAX_SKILL_NAME,
  SKILL_NAME_PATTERN, sha256,
} = require('./base');

const OPENCODE_TOOL_MAP = Object.freeze({
  Read: 'read',
  NotebookRead: 'read',
  Write: 'edit',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Bash: 'bash',
  Grep: 'grep',
  Glob: 'glob',
  LS: 'list',
  Task: 'task',
  TodoWrite: 'todowrite',
  WebFetch: 'webfetch',
  WebSearch: 'websearch',
});

const COPILOT_TOOL_MAP = Object.freeze({
  Read: 'read',
  NotebookRead: 'read',
  Write: 'edit',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Bash: 'execute',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  Task: 'agent',
  TodoWrite: 'todo',
  WebFetch: 'web',
  WebSearch: 'web',
});

function mapTools(tools, mapping, options = {}) {
  if (tools === null) return null;
  const mapped = [];
  const unknown = [];
  for (const tool of tools) {
    const canonical = mapping[tool] || mapping[String(tool).trim()];
    if (canonical) {
      if (!mapped.includes(canonical)) mapped.push(canonical);
    } else if (options.preserveUnknown) {
      if (!mapped.includes(tool)) mapped.push(tool);
      unknown.push(tool);
    } else {
      unknown.push(tool);
    }
  }
  return { mapped, unknown };
}

function normalizeDescription(value, fallback) {
  const description = String(value || fallback || '').replace(/\s+/g, ' ').trim();
  if (!description) return 'Reusable instructions installed by BuildWithCLI.';
  if (description.length <= MAX_SKILL_DESCRIPTION) return description;
  const slice = description.slice(0, MAX_SKILL_DESCRIPTION - 1);
  const boundary = slice.lastIndexOf(' ');
  return `${slice.slice(0, boundary > 800 ? boundary : slice.length).replace(/[.,;:!?-]+$/, '')}.`;
}

function compactHermesDescription(description) {
  const normalized = normalizeDescription(description);
  if (normalized.length <= 60 && /[.!?]$/.test(normalized)) return normalized;
  const firstSentence = normalized.match(/^(.{1,59}?[.!?])(?:\s|$)/)?.[1];
  if (firstSentence) return firstSentence;
  const slice = normalized.slice(0, 59);
  const boundary = slice.lastIndexOf(' ');
  const compact = slice.slice(0, boundary >= 30 ? boundary : slice.length).replace(/[.,;:!?-]+$/, '');
  return `${compact}.`;
}

function validateSkillName(name, context = 'skill') {
  if (!SKILL_NAME_PATTERN.test(name) || name.length > MAX_SKILL_NAME) {
    throw new BuildWithCliError(
      `${context} name '${name}' must be 1-${MAX_SKILL_NAME} characters and match ${SKILL_NAME_PATTERN}`,
      { code: 'INVALID_RESOURCE_NAME' },
    );
  }
}

function fitSkillName(value) {
  const normalized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'resource';
  if (normalized.length <= MAX_SKILL_NAME) return normalized;
  const digest = sha256(normalized).slice(0, 8);
  const prefix = normalized
    .slice(0, MAX_SKILL_NAME - digest.length - 1)
    .replace(/-+$/g, '') || 'resource';
  return `${prefix}-${digest}`;
}

module.exports = {
  OPENCODE_TOOL_MAP, COPILOT_TOOL_MAP, mapTools, normalizeDescription,
  compactHermesDescription, validateSkillName, fitSkillName,
};
