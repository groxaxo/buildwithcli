# Compatibility model

BuildWithCLI uses one catalogue, but it does not assume every coding CLI has the same extension system. Compatibility is split into three levels:

1. **Native projection** — BuildWithCLI emits the target's documented agent, command, or skill format.
2. **Portable Agent Skill projection** — the source resource is converted to a `SKILL.md` package.
3. **Explicit/manual configuration** — BuildWithCLI reports the resource but does not install it because automatic conversion would be unsafe or semantically false.

## Built-in target matrix

### OpenCode

Project scope:

```text
.opencode/agents/<name>.md
.opencode/commands/<name>.md
.opencode/skills/<name>/SKILL.md
```

User scope:

```text
${XDG_CONFIG_HOME:-~/.config}/opencode/agents/<name>.md
${XDG_CONFIG_HOME:-~/.config}/opencode/commands/<name>.md
${XDG_CONFIG_HOME:-~/.config}/opencode/skills/<name>/SKILL.md
```

Agent tool restrictions are translated into an OpenCode `permission` object. BuildWithCLI starts from wildcard deny and allows only tools that can be mapped safely. Unknown source tools are reported as warnings.

Commands are emitted in OpenCode's Markdown command format. Source argument placeholders are retained where OpenCode supports them.

### Hermes Agent

User scope uses Hermes' native skill directory:

```text
${HERMES_HOME:-~/.hermes}/skills/<name>/SKILL.md
```

Project scope uses:

```text
.agents/skills/<name>/SKILL.md
```

Hermes must be configured to load the project directory through `skills.external_dirs`. BuildWithCLI's `doctor` command checks for that configuration and prints the exact action when it is missing.

Hermes exposes skills as slash commands, so source agents and source commands are converted into skills rather than copied as incompatible Markdown files.

### OpenAI Codex CLI

Project scope:

```text
.agents/skills/<name>/SKILL.md
```

User scope:

```text
~/.agents/skills/<name>/SKILL.md
```

Codex receives source skills directly and receives agents/commands as deterministic Agent Skill projections. The portable skill frontmatter contains only interoperable fields: `name` and `description`, plus source metadata where the target format permits it.

### GitHub Copilot CLI

Project scope:

```text
.github/agents/<name>.agent.md
.claude/commands/<name>.md
.github/skills/<name>/SKILL.md
```

User scope:

```text
${COPILOT_HOME:-~/.copilot}/agents/<name>.agent.md
${COPILOT_HOME:-~/.copilot}/skills/<name>/SKILL.md
```

Copilot project agents use native frontmatter. Tool names are translated to Copilot's documented aliases (`read`, `edit`, `execute`, `search`, `agent`, `web`, and `todo`). Unknown names are retained so the resulting file remains reviewable, and a warning explains that Copilot will ignore them.

Copilot project commands and Claude Code commands share `.claude/commands`. BuildWithCLI therefore emits one deliberately shared dialect containing only fields understood by both runtimes: `description`, optional `argument-hint`, and optional `allowed-tools`. This prevents nondeterministic last-writer behavior under `--target all`.

Copilot has no documented user command directory. User-scoped source commands are converted to personal Copilot skills.

### Claude Code

Project scope:

```text
.claude/agents/<name>.md
.claude/commands/<name>.md
.claude/skills/<name>/SKILL.md
```

User scope uses the corresponding paths under `~/.claude`.

Agents retain their canonical source content. Commands use the same shared command dialect described above so Claude and Copilot can coexist in one project.

### Generic Agent Skills

Project scope:

```text
.agents/skills/<name>/SKILL.md
```

User scope:

```text
~/.agents/skills/<name>/SKILL.md
```

Use target `agents` for any CLI that follows the open Agent Skills convention. For a different directory, define a custom profile using the `portable-skill` format.

## Conversion behavior

### Agent to skill

The generated skill includes:

- a concise, valid `name` and `description`;
- an explicit "When to use" section;
- the source agent body as authoritative operating instructions;
- source metadata identifying the original kind and repository path where supported.

### Command to skill

The generated skill includes the original command procedure and rewrites vendor placeholders:

```text
$ARGUMENTS / ${ARGUMENTS} -> the complete arguments supplied with this invocation
$1                         -> the first supplied argument
$2                         -> the second supplied argument
```

The skill also instructs the target agent to treat text following the skill name as command input.

### Name collisions

Skills, converted agents, and converted commands share one namespace. BuildWithCLI allocates names in stable kind/name order:

```text
review          # original skill
command-review  # converted command
agent-review    # converted agent
```

Names are constrained to the Agent Skills 64-character limit. Long generated names receive a stable eight-character SHA-256 suffix.

### Supporting files

A source skill's files are copied recursively with their modes. BuildWithCLI rejects:

- symbolic links in the source tree;
- support files escaping the skill directory;
- files larger than the configured safety limit;
- destination paths escaping the selected target root.

## Not auto-projected

### Hooks

Hook systems disagree about event names, payloads, permissions, shell semantics, and whether execution is local or sandboxed. BuildWithCLI reports hook counts through `doctor`, but installation remains manual.

### MCP configuration

The MCP protocol is portable; each client's configuration file and trust policy are not. BuildWithCLI does not merge MCP server definitions automatically. Review and configure each server per client, particularly command-based servers and servers containing environment variables or credentials.

## Detection

`--target auto` checks `PATH` for these binaries:

```text
opencode
hermes
codex
copilot
claude
```

Detected targets are installed in declaration order. When none are present, BuildWithCLI chooses the generic `agents` target instead of failing or guessing another vendor format.
