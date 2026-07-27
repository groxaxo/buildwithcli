# Security and trust model

BuildWithCLI installs instructions that coding agents may execute. Its default posture is therefore **fail closed**: it would rather stop with a precise error than overwrite local work, follow an unsafe path, or invent compatibility.

## Trust boundaries

There are four separate trust boundaries:

1. **Catalogue source** — Markdown and supporting files under the selected `--catalog` root.
2. **Renderer** — the transformation from canonical content to a target format.
3. **Destination** — a project or user directory consumed by an agent CLI.
4. **Runtime** — the coding agent, its configured tools, credentials, MCP servers, hooks, and sandbox.

BuildWithCLI validates the first three. It cannot make an unsafe runtime configuration safe.

## Managed-file manifest

Managed files are recorded in:

```text
<project>/.buildwithcli/manifest.json
~/.buildwithcli/manifest.json
```

Each entry records:

- target owners;
- source kind, name, and path;
- output name and renderer;
- destination and target root;
- boundary root and scope;
- file mode;
- SHA-256 of installed bytes.

The manifest is data, not authority. Every loaded entry is revalidated before use. Project entries must stay inside the project boundary; user entries selected for uninstall must match roots recomputed from the currently loaded built-in/custom target profiles. A tampered manifest cannot nominate an arbitrary deletion root. Re-supply the original `--profile` when uninstalling a custom target.

## Transaction behavior

Before writing, BuildWithCLI:

1. resolves and validates every destination;
2. rejects duplicate destinations with different bytes or metadata;
3. compares existing bytes **and file mode** against the prior manifest;
4. refuses untracked or locally modified files unless `--force` is set;
5. stages all new content in sibling temporary files;
6. backs up files that will be replaced;
7. rechecks each destination with optimistic compare-and-swap semantics;
8. commits the staged files;
9. verifies final bytes/modes and rechecks the manifest snapshot;
10. writes the manifest atomically;
11. restores backups and removes partial output if any step fails.

A repeated install with unchanged source is a no-op.

## Shared ownership

Codex, Hermes project scope, and generic clients can share the same `.agents/skills` output. One manifest entry records all owning targets.

Uninstalling one owner detaches it without deleting the file. The physical file is removed only when no owner remains. This prevents one CLI's uninstall from breaking another CLI.

## Symlink and traversal defenses

BuildWithCLI rejects:

- symlinks anywhere in a source skill tree;
- source support paths outside the skill root;
- absolute or `..`-escaping project target roots;
- destination paths outside the resolved target root;
- existing parent symlinks that redirect a destination outside its allowed boundary;
- manifest, destination, or backup paths that resolve outside the project/home boundary.

These checks are performed again immediately before mutation. They reduce time-of-check/time-of-use exposure but cannot protect against a privileged local attacker racing filesystem mutations.

## Tool permissions

Tool identifiers are not standardized.

- OpenCode receives a wildcard-deny permission object when a source allow-list exists. Only recognized mappings are allowed.
- Copilot receives documented tool aliases. Unknown source names remain visible and generate warnings; Copilot is expected to ignore unrecognized tools.
- Portable skills do not claim to enforce source tool allow-lists because Agent Skills are instructions, not a universal permission boundary.

Always configure runtime-level permissions independently.

## Hooks

Hooks can execute shell commands based on agent events. Event names, input schemas, shells, and permission boundaries differ across products. BuildWithCLI does not install hooks automatically.

Review each hook and port it manually only after confirming:

- the exact event and payload schema;
- quoting and shell behavior on the host OS;
- working directory and environment variables;
- whether secrets are present;
- whether execution is sandboxed;
- timeout, concurrency, and retry behavior.

## MCP servers

BuildWithCLI does not automatically merge MCP configurations. Before adding an MCP server to a client, review:

- whether it launches a local command or connects to a remote URL;
- executable and package provenance;
- environment variables and credentials;
- filesystem/network scope;
- OAuth redirect and token storage behavior;
- tool annotations and destructive operations;
- approval and sandbox policy in that specific client.

Keep MCP Inspector or similar diagnostic tooling standalone; do not wire it into production agent startup automatically.

## `--force`

`--force` is intentionally explicit. It authorizes replacement/removal of destination files whose current bytes no longer match the manifest or were not previously tracked.

Use it only after reviewing:

```bash
node bin/buildwithcli.js plan ... --json
```

and preserving any local changes you intend to keep.

## Reporting issues

A security report should include the command, target/scope, operating system, relevant plan output, and a minimal filesystem layout. Remove tokens, credentials, personal paths, and proprietary source before sharing logs.
