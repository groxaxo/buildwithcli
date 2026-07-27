'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function write(root, relative, content, mode = 0o644) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { mode });
  await fs.chmod(file, mode);
  return file;
}

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buildwithcli-fixture-'));
  await write(root, 'package.json', JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2));
  await write(root, 'plugins/all-skills/skills/deploy/SKILL.md', `---\nname: deploy\ndescription: Deploy safely\ncategory: devops\nallowed-tools: Read, Bash\nmetadata:\n  owner: platform\n---\n\n# Deploy\n\nValidate, deploy, and verify.\n`);
  await write(root, 'plugins/all-skills/skills/deploy/scripts/run.sh', '#!/usr/bin/env bash\nset -euo pipefail\necho deploy\n', 0o755);
  await write(root, 'plugins/all-skills/skills/deploy/references/checklist.md', '# Checklist\n');

  await write(root, 'plugins/all-agents/agents/reviewer.md', `---\nname: reviewer\ndescription: Review code without editing\ntools:\n  - Read\n  - Grep\nmodel: sonnet\n---\n\nReview correctness and security.\n`);
  await write(root, 'plugins/all-agents/agents/inherit.md', `---\nname: inherit\ndescription: Inherit host policy\n---\n\nUse the host tool policy.\n`);
  await write(root, 'plugins/all-agents/agents/no-tools.md', `---\nname: no-tools\ndescription: No tools allowed\ntools: []\n---\n\nReason only.\n`);
  await write(root, 'plugins/all-commands/commands/fix.md', `---\ndescription: Fix a named issue\nargument-hint: <issue>\n---\n\nInspect $ARGUMENTS, fix it, and run tests. First token: $1.\n`);
  await write(root, 'plugins/all-hooks/hooks/audit.md', `---\nname: audit\ndescription: Audit shell calls\nevent: PreToolUse\nmatcher: Bash|execute\ncommand: node -e "process.stdin.resume()"\ntimeout: 5\n---\n\nAudit hook.\n`);
  await write(root, '.claude/settings.json', JSON.stringify({
    hooks: {
      PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node -e "process.stdin.resume()"', timeout: 4 }] }],
    },
  }, null, 2));
  await write(root, '.mcp.json', JSON.stringify({
    mcpServers: {
      localfs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'], env: { MODE: 'safe' }, timeout: 20 },
      remoteapi: { url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer ${MCP_TOKEN}', 'X-Tenant': '${TENANT_ID}' }, startup_timeout_sec: 7 },
    },
  }, null, 2));
  await write(root, 'opencode.jsonc', `{
    // This root config is used by all-profile tests.
    "mcp": {
      "jsonc-server": {
        "type": "local",
        "command": ["node", "server.js"],
        "timeout": 5000,
      },
    },
    "literal": ",}",
  }\n`);
  return root;
}

async function removeFixture(root) {
  await fs.rm(root, { recursive: true, force: true });
}

function mapSnapshot(files) {
  return [...files.entries()].map(([name, entry]) => [name, Buffer.isBuffer(entry.content) ? entry.content.toString('base64') : String(entry.content), entry.mode, entry.source]);
}

module.exports = { makeFixture, mapSnapshot, removeFixture, write };
