# BuildWithCLI portability security model

## Trust boundaries

The source catalog contains Markdown, bundled files, executable hook declarations, and MCP process/network configuration. The compiler treats these as untrusted input even when they live in the same repository.

### Hooks are disabled by default

Executable hook output requires two independent flags:

```bash
node bin/buildwithcli.js compile \
  --target all \
  --hooks trusted \
  --trust-hooks \
  --out .buildwithcli/trusted
```

This deliberate two-key gate prevents a configuration default or copied command from activating code execution. Review the source command, working directory, environment, matcher, and host event semantics first.

OpenCode and Hermes hook runners enforce bounded input/output, timeouts, process-group termination, and resolved working directories. Copilot and Codex exports use their native hook contracts. Unsupported events or unsafe matcher translations are reported and omitted.

### Least privilege

Tool metadata follows three distinct states:

1. **Missing tool list:** inherit the host's existing policy.
2. **Explicit non-empty list:** emit only safely mapped native tools.
3. **Explicit empty list:** preserve native deny-all where the host supports it; otherwise omit the executable artifact and document the source agent under `unsupported/agents/`.

Unknown tool names are never converted to full access. Generic MCP capability labels are not expanded into arbitrary server tools. Where a host lacks an exact per-artifact allow-list, the report marks the policy as advisory rather than claiming false enforcement.

### MCP secrets

The compiler preserves environment references and translates them only when a target requires a different syntax. It does not resolve environment variables and does not write their values into generated files.

Prefer environment-backed authorization over literal tokens. Inspect generated warnings for literal authorization headers before committing any output. Timeout values are canonicalized to seconds internally so millisecond-native OpenCode/Copilot inputs cannot become 1000× longer on second-native hosts.

### Filesystem integrity

The managed writer:

- normalizes every output path below a fixed root;
- rejects absolute paths, `..`, NUL bytes, and its own manifest path;
- rejects symlink roots, leaves, intermediate components, and missing roots beneath symlink ancestors;
- writes via same-directory temporary files, `fsync`, and atomic rename;
- records SHA-256 hashes and modes in `.buildwithcli-manifest.json`;
- refuses to overwrite unmanaged files or modified managed files without explicit flags;
- bounds output file count and aggregate bytes.

### Parser constraints

The built-in frontmatter parser supports a deliberately bounded YAML subset. It rejects aliases, anchors, custom tags, duplicate keys, tabs in indentation, and ambiguous executable constructs. JSONC parsing removes comments and trailing commas without evaluating JavaScript.

### No remote automation dependency

Validation and compilation run locally with Node.js. The implementation does not require GitHub Actions, remote build runners, or network access.
