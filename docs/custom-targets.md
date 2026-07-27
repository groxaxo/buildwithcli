# Custom target profiles

A target profile lets BuildWithCLI support an additional coding CLI without adding vendor-specific branching to the installer.

Pass one or more files with `--profile`:

```bash
node bin/buildwithcli.js install '*' \
  --profile ./examples/targets/portable-agent-skills.json \
  --target mycli
```

A file may contain one profile, an array of profiles, or an object with a `targets` array.

## Minimal portable profile

```json
{
  "id": "mycli",
  "displayName": "My CLI",
  "binaries": ["mycli"],
  "project": {
    "roots": {
      "skill": ".mycli/skills"
    },
    "formats": {
      "agent": "portable-skill",
      "command": "portable-skill",
      "skill": "portable-skill"
    }
  },
  "user": {
    "roots": {
      "skill": "${MYCLI_HOME:-~/.mycli}/skills"
    },
    "formats": {
      "agent": "portable-skill",
      "command": "portable-skill",
      "skill": "portable-skill"
    }
  },
  "notes": [
    "My CLI discovers Agent Skills recursively from these directories."
  ]
}
```

## Fields

| Field | Required | Meaning |
|---|---:|---|
| `id` | yes | Lowercase, hyphen-separated target identifier, maximum 64 characters |
| `displayName` | no | Human-readable target name |
| `binaries` | no | Executables used by `--target auto` |
| `project` | project or user | Project-scoped roots and formats |
| `user` | project or user | User-scoped roots and formats |
| `notes` | no | Operational notes displayed in plans |

A profile may support only project scope or only user scope. Selecting an unsupported scope fails explicitly.

## Scope configuration

Each scope contains:

```json
{
  "roots": {
    "agent": ".mycli/agents",
    "command": ".mycli/commands",
    "skill": ".mycli/skills"
  },
  "formats": {
    "agent": "opencode-agent",
    "command": "opencode-command",
    "skill": "portable-skill"
  }
}
```

For a skill format, all resource kinds use `roots.skill`. For a native agent or command format, the corresponding `roots.agent` or `roots.command` entry is required.

Project roots must be relative and may not escape the project. User roots may be absolute or use environment templates.

## Environment templates

Supported forms:

```text
${VARIABLE}
${VARIABLE:-fallback}
~
~/relative/path
```

Examples:

```json
{
  "skill": "${XDG_CONFIG_HOME:-~/.config}/mycli/skills"
}
```

Environment expansion occurs before path validation.

## Supported renderer names

### Portable/native skill renderers

- `portable-skill`
- `opencode-skill`
- `hermes-skill`
- `codex-skill`
- `copilot-skill`
- `claude-skill`

`portable-skill` is the correct default for Agent Skills-compatible CLIs. Vendor skill renderers differ only where that vendor documents additional safe metadata.

### Native agent/command renderers

- `opencode-agent`
- `opencode-command`
- `copilot-agent`
- `copilot-command`
- `shared-command`
- `claude-native`

`claude-native` copies the canonical source file, so use it only where that source grammar is genuinely supported.

## Safety rules

Profiles cannot:

- replace an existing built-in target ID;
- define unsupported renderer names;
- map a format without its required root;
- define an empty scope;
- use absolute project roots;
- traverse outside the project with `..`;
- cause final destinations to escape the resolved root through symlinks.

Use `plan` before installation:

```bash
node bin/buildwithcli.js plan '*' \
  --profile ./my-target.json \
  --target mycli \
  --json
```

The JSON plan includes every destination, source kind, source name, renderer, mode, owner target, and content SHA-256.
