# Contributing to BuildWithCLI

BuildWithCLI maintains a curated canonical catalogue and a provider-neutral projection layer for OpenCode, Hermes Agent, OpenAI Codex CLI, GitHub Copilot CLI, Claude Code, and Agent Skills-compatible tools.

Contributions fall into two categories:

1. **Catalogue resources** — agents, commands, skills, hooks, and Claude marketplace packages under `plugins/`.
2. **Compatibility/runtime code** — the installer, renderers, lifecycle logic, tests, and documentation under `bin/`, `lib/`, `tests/`, and `docs/`.

## Before you start

- Search existing resources for overlapping names and responsibilities.
- Keep each resource focused on one repeatable capability.
- For target-format changes, verify behavior against current primary vendor documentation.
- Never claim a resource is portable merely because another CLI accepts Markdown.
- Do not add automatic hook or MCP projection without an explicit, fail-closed threat model and tests.

## Repository structure

```text
plugins/
├── agents-<category>/agents/*.md
├── commands-<category>/commands/*.md
├── hooks-<category>/hooks/*.md
├── all-skills/skills/<skill-name>/SKILL.md
├── all-agents/                 # optional aggregate bundle
├── all-commands/               # optional aggregate bundle
└── all-hooks/                  # optional aggregate bundle

bin/buildwithcli.js             # executable entrypoint
lib/buildwithcli.js             # compatibility and lifecycle core
tests/buildwithcli.test.js      # filesystem-level compatibility/security tests
docs/                           # compatibility, profiles, and security model
examples/targets/               # custom target profile examples
```

## Canonical resource formats

The catalogue retains its established source formats. BuildWithCLI renders them into each target format at install/export time.

### Agent

Location:

```text
plugins/agents-<category>/agents/<agent-name>.md
```

```markdown
---
name: agent-name
description: Clear trigger conditions and responsibility
category: category-name
tools: Read, Write, Bash
---

You are a specialist responsible for ...
```

Requirements:

- `name` matches the filename, uses lowercase letters/numbers/hyphens, and is at most 64 characters;
- `description` makes invocation conditions explicit;
- `tools`, when present, is an allow-list rather than a list of examples;
- instructions state required validation and expected deliverables;
- do not assume vendor-specific tools unless the resource genuinely requires them.

### Command

Location:

```text
plugins/commands-<category>/commands/<command-name>.md
```

```markdown
---
description: What the command does
category: category-name
argument-hint: "[optional arguments]"
allowed-tools: Read, Bash
---

# Command procedure

Use $ARGUMENTS as the invocation input ...
```

BuildWithCLI rewrites `$ARGUMENTS`, `${ARGUMENTS}`, `$1`, `$2`, and similar placeholders when a command is projected to a portable skill.

### Skill

Location:

```text
plugins/all-skills/skills/<skill-name>/SKILL.md
```

```markdown
---
name: skill-name
description: What this skill does and when an agent should load it
category: category-name
---

# Skill Name

Operating instructions ...
```

Supporting files may live beside `SKILL.md`. Do not use symlinks. Keep references relative to the skill directory and include only files the skill actually needs.

### Hooks and MCP entries

Hooks and MCP server catalogues remain useful canonical resources, but BuildWithCLI does not automatically install them into non-Claude clients. Their execution and trust models differ between products.

A hook contribution must document:

- event and payload schema;
- shell/interpreter requirements;
- environment variables;
- working-directory assumptions;
- destructive behavior and permissions;
- timeout/concurrency behavior.

An MCP contribution must document transport, executable or URL provenance, required credentials, filesystem/network reach, and destructive tools.

## Adding or changing a built-in target

A target definition contains project/user roots, renderer names, binary detection, and operational notes. Keep these invariants:

- native output only where the target documents that surface;
- portable `SKILL.md` fallback when no native agent/command surface exists;
- one deterministic byte sequence for any path shared by multiple targets;
- no silent permission widening;
- no project path may be absolute or escape with `..`;
- user paths must support the documented home/environment behavior;
- shared `.agents/skills` output must retain all owner target IDs;
- uninstall must detach one owner without removing files still owned by another.

Add tests for project scope, user scope, rendering, collisions, and lifecycle behavior.

## Adding a renderer

A new renderer must:

1. consume the canonical resource model rather than reparsing source ad hoc;
2. emit deterministic UTF-8 with stable YAML ordering;
3. validate target limits before writing;
4. explicitly map or reject tool identifiers;
5. preserve support files for skills;
6. avoid fields unsupported by the target;
7. produce the same bytes whenever multiple targets share a destination.

Prefer extending a custom target profile over adding a built-in renderer when the target follows an existing format.

## Security requirements

Changes to install, update, export, manifest, or uninstall behavior must preserve:

- atomic staging and rollback;
- optimistic CAS checks on destinations and manifests;
- refusal to adopt untracked files without `--force`;
- content **and mode** protection for local changes;
- source symlink rejection;
- canonical destination/root/boundary validation;
- target-profile validation for user manifest roots;
- duplicate-destination rejection;
- shared ownership semantics;
- fail-closed behavior for malformed manifests and profiles.

Every bug fix in this area needs a regression test using real temporary filesystem operations.

## Local validation

Node.js 18.18 or newer is required.

```bash
npm install

# Compatibility/security adapter suite
npm run test:cli

# Syntax and command surface
node --check lib/buildwithcli.js
node --check bin/buildwithcli.js
node bin/buildwithcli.js targets
node bin/buildwithcli.js --help

# Existing catalogue validation and all unit tests
npm test
```

Do not rely on GitHub Actions as the only validation path. Pull requests must include the exact local commands and results.

## Test expectations

At minimum, target/lifecycle changes should cover the relevant cases:

- native path and frontmatter output;
- portable agent/command conversion;
- command argument rewriting;
- tool alias mapping and unknown-tool warnings;
- name collisions and 64-character limits;
- support-file copying;
- auto target detection;
- custom target profiles;
- idempotent create/no-op/update;
- local content and mode modifications;
- untracked identical destinations;
- shared-owner detach/final remove;
- malformed/tampered manifests;
- source and destination symlink escapes;
- user roots controlled by `XDG_CONFIG_HOME`, `HERMES_HOME`, and `COPILOT_HOME`;
- export containment.

## Pull request format

Use a focused branch and conventional commit. A useful PR description includes:

```markdown
## Summary
- What changed
- Why this compatibility model is correct

## Target behavior
- Native surfaces used
- Portable fallbacks used
- Unsupported/manual surfaces

## Security and lifecycle
- Permission behavior
- Path/manifest behavior
- Shared ownership impact

## Verification
- `npm run test:cli` — N/N passed
- `npm test` — result
- Manual command/output checks
```

Keep generated output, local manifests, credentials, and runtime configuration out of commits.

## Code of conduct

Be precise, constructive, and respectful. Do not contribute malicious automation, credential theft, covert persistence, destructive defaults, or resources designed to bypass a user's approval and sandbox policies.
