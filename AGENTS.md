# BuildWithCLI engineering instructions

## Objective

Maintain one canonical resource catalogue and project it into each supported CLI without overstating compatibility. Native formats are preferred only when documented; otherwise use Agent Skills. Hooks and MCP configuration remain explicit/manual unless a future implementation has a fully specified, tested, fail-closed adapter.

## Runtime

- Node.js 18.18 or newer.
- CommonJS for the dependency-free compatibility core under `lib/` and `bin/`.
- Do not add a runtime dependency when the standard library is sufficient.
- Do not use GitHub Actions as the verification path; all gates must run locally.

## Required gates

Run before committing changes to the adapter:

```bash
node --check lib/buildwithcli.js
node --check bin/buildwithcli.js
node --test tests/buildwithcli.test.js
node bin/buildwithcli.js targets
```

Run the repository-wide gates when dependencies and the complete checkout are available:

```bash
npm test
```

## Correctness invariants

- Installation and uninstall are idempotent.
- Never overwrite an untracked or modified destination without explicit `--force`.
- All writes are staged and rolled back on failure.
- A destination must remain inside its declared target root and project/home boundary after canonical path resolution.
- Reject source symlinks and destination symlink escapes.
- Revalidate manifest entries before using them; never trust stored paths blindly.
- Shared output has shared ownership. Removing one target must not remove a file still owned by another target.
- `--target all` must produce deterministic bytes for shared paths, especially `.claude/commands` and `.agents/skills`.
- Unknown tool mappings warn or fail closed; they must never widen permissions silently.
- Portable skill names must be stable, valid, unique within a namespace, and at most 64 characters.
- Custom project roots must be relative and unable to escape with `..`.

## Compatibility policy

- Verify current formats against primary vendor documentation.
- Keep vendor-specific fields out of shared output unless every owner accepts identical bytes and semantics.
- Preserve source support files for skills.
- Convert commands and agents to skills only when the target lacks a native surface.
- Reword vendor placeholders such as `$ARGUMENTS` in portable skills.
- Report unsupported hooks/MCP files; do not pretend they were installed.

## Tests

Every lifecycle or security fix needs a regression test. Prefer temporary directories and real filesystem operations over mocks for path, manifest, atomicity, ownership, and symlink behavior.
