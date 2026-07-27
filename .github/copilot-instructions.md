# BuildWithCLI contributor instructions

This repository projects one canonical catalogue into OpenCode, Hermes Agent, Codex CLI, Copilot CLI, Claude Code, and generic Agent Skills layouts.

When editing the adapter:

- preserve native formats only where current primary documentation supports them;
- use portable `SKILL.md` conversion as the fallback;
- keep hooks and MCP configuration fail-closed and manual;
- never widen a source tool allow-list silently;
- preserve atomic writes, rollback, local-edit protection, canonical boundary checks, and shared target ownership;
- ensure shared destinations render identical bytes under `--target all`;
- keep generated skill names deterministic and at most 64 characters;
- add a Node test for every behavior or bug fix.

Local gates:

```bash
node --check lib/buildwithcli.js
node --check bin/buildwithcli.js
node --test tests/buildwithcli.test.js
node bin/buildwithcli.js targets
```

Do not rely on GitHub Actions as the only validation path.
