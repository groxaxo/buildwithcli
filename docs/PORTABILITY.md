# BuildWithCLI multi-agent portability

BuildWithCLI keeps the existing Claude Code marketplace intact and adds a deterministic compiler that translates the canonical catalog into the native extension surfaces of multiple agent CLIs.

## Supported targets

| Target | Skills | Agents | Commands | Hooks | MCP |
|---|---|---|---|---|---|
| OpenCode | `.opencode/skills` | `.opencode/agents` | `.opencode/commands` | trusted JS plugin | `opencode.json` |
| Hermes Agent | plugin skills | safely representable agents converted to namespaced skills; deny-all agents documented only | native slash commands plus skills | trusted Python plugin hooks | `config.fragment.yaml` |
| Codex CLI | `.agents/skills` and plugin skills | `.codex/agents/*.toml`; read/search roles get read-only sandbox; deny-all roles documented only | plugin commands plus skills | trusted plugin/project hooks | `.codex/config.toml` and `.mcp.json` |
| GitHub Copilot CLI | plugin and `.github/skills` | plugin and `.github/agents` | plugin commands and `.claude/commands` | `hooks.json` / `.github/hooks` | `.mcp.json` / `.github/mcp.json` |
| Claude Code | native plugin skills | native agents | native commands | native hooks | `.mcp.json` |
| Universal | `.agents/skills` | safely representable agents converted to skills; deny-all agents documented only | converted to skills | documented only | portable `.mcp.json` |
| Custom | configurable skill/native paths | declarative | declarative | never guessed | configurable JSON path |

“Native” does not mean “silently equivalent.” Each adapter emits an audit report describing every warning and declared degradation. Unsupported semantics are omitted or converted explicitly instead of being approximated dangerously.

## Local workflow

```bash
npm install
npm run portable:doctor
npm run portable:scan
npm run validate:portable
npm run test:portable
npm run portable:compile
```

`portable:compile` writes all built-in targets below `.buildwithcli/dist/<target>`. Generated trees are managed by `.buildwithcli-manifest.json`; subsequent runs update only files still owned and unmodified by the compiler.

### Compile one target

```bash
node bin/buildwithcli.js compile \
  --target opencode \
  --profile curated \
  --out .buildwithcli/opencode
```

### Scan every discoverable component

```bash
node bin/buildwithcli.js compile \
  --target all \
  --profile all \
  --out .buildwithcli/all
```

The `curated` profile reads the repository's aggregate `all-skills`, `all-agents`, `all-commands`, and `all-hooks` bundles. The `all` profile discovers every compatible source file and uses deterministic collision namespacing.

## Target installation

### OpenCode

Merge the generated `.opencode` tree and `opencode.json` into the target repository. Do not replace unrelated keys in an existing `opencode.json`. Environment references in remote MCP headers are translated to OpenCode's `{env:NAME}` syntax.

### Hermes Agent

Copy the generated Hermes directory to `~/.hermes/plugins/buildwithcli-catalog`, merge `config.fragment.yaml` into `~/.hermes/config.yaml`, and enable the plugin:

```bash
hermes plugins enable buildwithcli-catalog
```

Hermes has no universal Claude-style subagent file contract, so safely representable specialist agents are preserved as namespaced, read-only plugin skills. Source tool lists remain advisory metadata because a skill is not an isolated per-agent sandbox. Agents with an explicit empty tool list are documented under `unsupported/agents/` and are not emitted as executable skills. Slash commands are registered natively.

### Codex CLI

Use either the project-native tree or the generated plugin:

- merge `.agents/skills`, `.codex/agents`, and `.codex/config.toml` into a project; or
- register the directory containing `.codex-plugin/plugin.json` in a Codex marketplace.

Merge TOML tables rather than replacing existing project settings. Codex role files do not provide an exact per-role tool-name allow-list: source lists are retained as hard instructions, read/search-only roles receive `sandbox_mode = "read-only"`, and explicit deny-all agents are documented rather than emitted executable.

### GitHub Copilot CLI

Install the generated plugin directory locally:

```bash
cd .buildwithcli/dist/copilot
copilot plugin install .
```

For repository-native configuration, merge `.github/agents`, `.github/skills`, `.claude/commands`, `.github/mcp.json`, and, after review, `.github/hooks/buildwithcli.json`.

### Claude Code

The Claude target retains the original plugin model and emits a normalized `.claude-plugin/plugin.json`, skills, agents, commands, hooks, and MCP descriptor.

## Other CLI tools

The universal target uses the open Agent Skills layout, `AGENTS.md`, and a portable MCP descriptor. Because arbitrary hosts cannot be assumed to enforce skill tool metadata, explicit deny-all agents are documented instead of compiled into executable skills. It is the safe default for Gemini CLI, Aider, Continue, Goose, Qwen Code, or another host that can consume repository instructions and skills but lacks a maintained native adapter.

For a known native directory layout, copy `buildwithcli.target.example.json` and compile it without changing compiler code:

```bash
node bin/buildwithcli.js compile \
  --target custom \
  --config ./my-target.json \
  --out .buildwithcli/my-target
```

A custom descriptor can choose native agent and command directories or convert either component type to Agent Skills. Native files preserve source metadata but are reported as schema-unverified; converted skills treat tool metadata as advisory and omit explicit deny-all agents. It never generates executable hooks because hook payloads and blocking semantics require a reviewed code adapter.

## Tool-policy fidelity

BuildWithCLI distinguishes three source states: missing tool metadata inherits host policy; a non-empty list is mapped as narrowly as the host permits; and an explicit empty list remains deny-all. When a host cannot enforce deny-all for the emitted artifact type, BuildWithCLI emits documentation under `unsupported/agents/` instead of broadening authority. OpenCode and Copilot have concrete per-agent tool fields. Codex can host-enforce a read-only filesystem sandbox but not an exact per-role tool-name list. Hermes, universal, and custom skill exports therefore report non-empty tool policies as advisory.

## MCP normalization

The scanner records canonical timeout values in seconds. Millisecond-native inputs from OpenCode and Copilot are divided by 1000 before canonicalization, then rendered back in the unit expected by each target. Environment references are translated without resolving secrets, and literal sensitive values produce warnings that never echo the credential.

## Reproducibility and conflict handling

- Outputs are byte-reproducible unless `--stamp` is supplied.
- Writes are atomic and recorded in a content-hash manifest.
- Path traversal, manifest injection, output symlinks, and symlink ancestors are rejected.
- Unmanaged destination files are protected unless `--replace-unmanaged` is explicit.
- Locally edited managed files are protected unless `--force` is explicit.
- `--clean` removes only obsolete managed files whose content still matches the previous manifest.

Use `--dry-run --json` to inspect every operation before writing.
