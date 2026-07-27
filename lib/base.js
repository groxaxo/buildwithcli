'use strict';

const crypto = require('node:crypto');

const VERSION = '1.0.0';
const MANIFEST_VERSION = 1;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_NAME = 64;
const MAX_SKILL_DESCRIPTION = 1024;
const MAX_COPILOT_AGENT_PROMPT = 30000;
const MAX_SOURCE_FILE_BYTES = 25 * 1024 * 1024;
const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
]);
const IGNORED_FILE_NAMES = new Set(['.DS_Store']);

const KIND_ORDER = Object.freeze({ skill: 0, command: 1, agent: 2 });

const TARGETS = Object.freeze({
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    binaries: ['opencode'],
    project: {
      roots: {
        agent: '.opencode/agents',
        command: '.opencode/commands',
        skill: '.opencode/skills',
      },
      formats: {
        agent: 'opencode-agent',
        command: 'opencode-command',
        skill: 'opencode-skill',
      },
    },
    user: {
      roots: {
        agent: '${XDG_CONFIG_HOME:-~/.config}/opencode/agents',
        command: '${XDG_CONFIG_HOME:-~/.config}/opencode/commands',
        skill: '${XDG_CONFIG_HOME:-~/.config}/opencode/skills',
      },
      formats: {
        agent: 'opencode-agent',
        command: 'opencode-command',
        skill: 'opencode-skill',
      },
    },
    notes: [
      'Agents and commands use OpenCode native Markdown formats; skills use OpenCode Agent Skills.',
    ],
  },
  hermes: {
    id: 'hermes',
    displayName: 'Hermes Agent',
    binaries: ['hermes'],
    project: {
      roots: { skill: '.agents/skills' },
      formats: {
        agent: 'portable-skill',
        command: 'portable-skill',
        skill: 'portable-skill',
      },
      notes: [
        'Hermes must list this project .agents/skills directory under skills.external_dirs in ~/.hermes/config.yaml.',
      ],
    },
    user: {
      roots: { skill: '${HERMES_HOME:-~/.hermes}/skills' },
      formats: {
        agent: 'hermes-skill',
        command: 'hermes-skill',
        skill: 'hermes-skill',
      },
    },
    notes: [
      'Hermes exposes every installed skill as a slash command; agents and commands are projected to skills.',
    ],
  },
  codex: {
    id: 'codex',
    displayName: 'OpenAI Codex CLI',
    binaries: ['codex'],
    project: {
      roots: { skill: '.agents/skills' },
      formats: {
        agent: 'portable-skill',
        command: 'portable-skill',
        skill: 'portable-skill',
      },
    },
    user: {
      roots: { skill: '~/.agents/skills' },
      formats: {
        agent: 'portable-skill',
        command: 'portable-skill',
        skill: 'portable-skill',
      },
    },
    notes: [
      'Codex discovers project and user Agent Skills from .agents/skills.',
    ],
  },
  copilot: {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    binaries: ['copilot'],
    project: {
      roots: {
        agent: '.github/agents',
        command: '.claude/commands',
        skill: '.github/skills',
      },
      formats: {
        agent: 'copilot-agent',
        command: 'shared-command',
        skill: 'copilot-skill',
      },
    },
    user: {
      roots: {
        agent: '${COPILOT_HOME:-~/.copilot}/agents',
        skill: '${COPILOT_HOME:-~/.copilot}/skills',
      },
      formats: {
        agent: 'copilot-agent',
        command: 'copilot-skill',
        skill: 'copilot-skill',
      },
    },
    notes: [
      'Project commands use Copilot CLI\'s Claude-compatible .claude/commands format.',
      'User-scoped commands are projected to personal Copilot skills because Copilot documents no user command directory.',
    ],
  },
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    binaries: ['claude'],
    project: {
      roots: {
        agent: '.claude/agents',
        command: '.claude/commands',
        skill: '.claude/skills',
      },
      formats: {
        agent: 'claude-native',
        command: 'shared-command',
        skill: 'claude-skill',
      },
    },
    user: {
      roots: {
        agent: '~/.claude/agents',
        command: '~/.claude/commands',
        skill: '~/.claude/skills',
      },
      formats: {
        agent: 'claude-native',
        command: 'shared-command',
        skill: 'claude-skill',
      },
    },
    notes: ['Retains compatibility with the repository\'s original Claude Code resources.'],
  },
  agents: {
    id: 'agents',
    displayName: 'Generic Agent Skills',
    binaries: [],
    project: {
      roots: { skill: '.agents/skills' },
      formats: {
        agent: 'portable-skill',
        command: 'portable-skill',
        skill: 'portable-skill',
      },
    },
    user: {
      roots: { skill: '~/.agents/skills' },
      formats: {
        agent: 'portable-skill',
        command: 'portable-skill',
        skill: 'portable-skill',
      },
    },
    notes: [
      'Portable fallback for any CLI that implements the open Agent Skills convention.',
    ],
  },
});

class BuildWithCliError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'BuildWithCliError';
    this.code = options.code || 'BUILDWITHCLI_ERROR';
    this.exitCode = options.exitCode || 1;
    this.details = options.details;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeNewlines(value) {
  return String(value).replace(/\r\n?/g, '\n');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  VERSION, MANIFEST_VERSION, SKILL_NAME_PATTERN, MAX_SKILL_NAME,
  MAX_SKILL_DESCRIPTION, MAX_COPILOT_AGENT_PROMPT, MAX_SOURCE_FILE_BYTES,
  IGNORED_DIRECTORY_NAMES, IGNORED_FILE_NAMES, KIND_ORDER, TARGETS,
  BuildWithCliError, sha256, normalizeNewlines, isPlainObject,
};
