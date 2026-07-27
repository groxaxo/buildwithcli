---
name: buildwithcli-portability
description: Compile, validate, audit, and install the BuildWithCLI catalog for OpenCode, Hermes Agent, Codex CLI, GitHub Copilot CLI, Claude Code, or another agent CLI.
compatibility: Requires Node.js 20 or newer and a local checkout of groxaxo/buildwithcli.
metadata:
  owner: BuildWithCLI
  security: hooks-disabled-by-default
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
---

# BuildWithCLI portability

Use this skill when adapting or installing this catalog for an agent CLI.

## Operating contract

1. Run `npm run portable:doctor` and `npm run validate:portable` before compilation.
2. Compile with `npm run portable:compile` or `node bin/buildwithcli.js compile --target <target> --out <directory>`.
3. Keep executable hooks disabled unless the operator has reviewed every source command. Trusted hook compilation requires both `--hooks trusted` and `--trust-hooks`.
4. Never overwrite an existing host config wholesale. Merge generated MCP, hook, and TOML/JSON fragments into the host's existing configuration.
5. Treat explicit source tool lists as least-privilege restrictions. Missing tool metadata inherits the host policy; an explicit empty list remains empty.
6. For an unsupported CLI, use `--target universal`, or copy `buildwithcli.target.example.json`, adjust its paths, and compile with `--target custom --config <file>`.
7. Run `npm run test:portable` after changing scanner, normalizer, adapters, hooks, filesystem writes, or target schemas.

## Standard commands

```bash
npm run portable:doctor
npm run portable:scan
npm run validate:portable
npm run test:portable
npm run portable:compile

# One target
node bin/buildwithcli.js compile --target opencode --out .buildwithcli/opencode

# A future CLI through a declarative adapter
node bin/buildwithcli.js compile \
  --target custom \
  --config buildwithcli.target.example.json \
  --out .buildwithcli/gemini
```

Read `docs/PORTABILITY.md` for target-specific installation and `docs/PORTABILITY_SECURITY.md` before enabling hooks.
