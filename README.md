# BuildWithCLI

**One canonical catalogue of agents, commands, and skills—projected safely into the native formats used by OpenCode, Hermes Agent, OpenAI Codex CLI, GitHub Copilot CLI, Claude Code, and any Agent Skills-compatible CLI.**

BuildWithCLI keeps the repository's curated resources as the source of truth and adds a deterministic compatibility layer around them. It does **not** blindly copy Claude-specific files into every tool. Each target gets either its documented native format or a portable `SKILL.md` projection.

## What it supports

| Target | Agents | Commands | Skills | Project destination |
|---|---|---|---|---|
| OpenCode | Native | Native | Native Agent Skills | `.opencode/agents`, `.opencode/commands`, `.opencode/skills` |
| Hermes Agent | Converted to skills | Converted to skills | Native skills | `.agents/skills` |
| OpenAI Codex CLI | Converted to Agent Skills | Converted to Agent Skills | Native Agent Skills | `.agents/skills` |
| GitHub Copilot CLI | Native custom agents | Native project commands | Native Agent Skills | `.github/agents`, `.claude/commands`, `.github/skills` |
| Claude Code | Native | Native | Native | `.claude/agents`, `.claude/commands`, `.claude/skills` |
| Generic CLI | Converted to Agent Skills | Converted to Agent Skills | Agent Skills | `.agents/skills` |

The generic target covers CLIs that implement the open Agent Skills convention. Tools with another layout can be added without changing the code by supplying a custom target profile.

## Quick start

Requirements: **Node.js 18.18 or newer**.

```bash
npm install

# Inspect the catalogue and target paths without changing anything
node bin/buildwithcli.js doctor --target all --skip-binary-check

# Install into every supported CLI detected on PATH
node bin/buildwithcli.js install --target auto

# Install selected resources into explicit targets
node bin/buildwithcli.js install \
  agent:python-* command:commit skill:mcp-builder \
  --target opencode,hermes,codex,copilot

# Preview the exact writes
node bin/buildwithcli.js plan '*' --target all

# Install personal resources rather than project resources
node bin/buildwithcli.js install skill:mcp-builder --target all --scope user
```

The `buildwithcli` executable is also exposed through `package.json`:

```bash
npm exec -- buildwithcli targets
```

## Commands

```text
buildwithcli targets [--json]
buildwithcli list [selectors...] [--kind agent,command,skill] [--json]
buildwithcli doctor [--target auto|all|TARGET] [--scope project|user]
buildwithcli install [selectors...] [--target auto|all|TARGET]
buildwithcli plan [selectors...] [install options]
buildwithcli export [selectors...] --output DIR [--target all]
buildwithcli uninstall [selectors...] [--target TARGET]
```

Selectors are deterministic and composable:

```bash
buildwithcli list '*'
buildwithcli install python-expert --target auto
buildwithcli install 'agent:python-*' 'command:commit' --target all
buildwithcli install '*' --exclude 'command:*' --kind agent,skill --target codex
```

`--target` can be repeated or comma-separated:

- `auto`: detect installed target binaries; fall back to generic Agent Skills.
- `all`: all built-in targets.
- `opencode`, `hermes`, `codex`, `copilot`, `claude`, `agents`: explicit targets.

## Hermes project setup

Hermes loads personal skills directly from `~/.hermes/skills`. For project-scoped installs, BuildWithCLI deliberately uses the shared `.agents/skills` directory so Codex, Hermes, and generic clients can own one physical copy.

Add the project directory to `~/.hermes/config.yaml`:

```yaml
skills:
  external_dirs:
    - /absolute/path/to/project/.agents/skills
```

Then verify it:

```bash
node bin/buildwithcli.js doctor --target hermes --project /absolute/path/to/project
```

## Safe, idempotent installation

BuildWithCLI records managed files in:

- project scope: `<project>/.buildwithcli/manifest.json`
- user scope: `~/.buildwithcli/manifest.json`

The installer:

- stages writes before replacing destinations;
- rolls back if a transaction fails;
- refuses to overwrite untracked or locally modified files unless `--force` is explicit;
- refuses to uninstall modified files unless `--force` is explicit;
- rejects source symlinks and destination symlink escapes;
- tracks shared ownership when several targets use the same `.agents/skills` file;
- removes a shared file only after its final owning target is uninstalled;
- detects duplicate catalogue entries and can fail on conflicts with `--strict`.

## Why hooks and MCP configuration are not copied automatically

Hook event names, permission models, executable environments, and MCP configuration schemas differ materially between CLIs. Treating them as interchangeable can execute unintended commands or grant unintended access.

BuildWithCLI therefore discovers and reports hooks and MCP files, but **does not auto-project them**. Configure those surfaces explicitly for each runtime after review. See [`docs/security.md`](docs/security.md).

## Portable conversion rules

When a target has no native agent or command format:

- an agent becomes a named Agent Skill containing its authoritative operating instructions;
- a command becomes an Agent Skill, with `$ARGUMENTS`, `${ARGUMENTS}`, `$1`, `$2`, and similar placeholders rewritten into vendor-neutral invocation language;
- collisions across kinds receive deterministic names such as `agent-review` and `command-review`;
- names longer than the Agent Skills limit receive a deterministic hash suffix;
- skill support files are copied with the skill and checked against path traversal.

Native tool allow-lists are preserved where the target supports them. Unknown vendor-specific tools generate warnings rather than silently widening access.

## Export a distributable multi-CLI bundle

`export` writes an isolated project tree and defaults to every built-in target:

```bash
node bin/buildwithcli.js export '*' --output ./dist/buildwithcli-bundle
```

No output may escape the requested export directory.

## Add any other CLI

Create a JSON target profile and pass it with `--profile`:

```bash
node bin/buildwithcli.js install '*' \
  --profile ./examples/targets/portable-agent-skills.json \
  --target mycli
```

Profiles can target native formats already implemented by BuildWithCLI or the portable Agent Skills renderer. See [`docs/custom-targets.md`](docs/custom-targets.md).

## Development and verification

```bash
# Fast compatibility/security suite
npm run test:cli

# Existing catalogue validation plus unit tests
npm test

# Syntax and target inspection
node --check lib/buildwithcli.js
node bin/buildwithcli.js targets
```

The CLI compatibility suite covers native rendering, portable conversion, collisions, environment-specific user roots, auto-detection, dry-run/export behavior, atomic updates, local-edit protection, shared ownership, custom profiles, and symlink/path traversal defenses.

## Existing Claude marketplace and web UI

The original Claude Code marketplace under `.claude-plugin/` remains intact. Existing Claude users can continue using the marketplace flow while BuildWithCLI provides a separate cross-CLI installation path.

The legacy discovery UI and curated catalogue are retained from [Dave Poon's Build with Claude project](https://github.com/davepoon/buildwithclaude). This fork adds the provider-neutral CLI projection and lifecycle layer.

## Documentation

- [`docs/compatibility.md`](docs/compatibility.md) — exact target mappings and limitations
- [`docs/custom-targets.md`](docs/custom-targets.md) — custom target profile reference
- [`docs/security.md`](docs/security.md) — trust model and failure behavior
- [`AGENTS.md`](AGENTS.md) — repository engineering rules for coding agents

## License

MIT. See [`LICENSE`](LICENSE).
