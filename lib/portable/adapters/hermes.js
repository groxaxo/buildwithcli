'use strict';

const { stringifyYaml } = require('../frontmatter');
const { commandArgumentHint, mapHookEvent, normalizedToolKey, normalizeMatcher, sourceTools } = require('../normalize');
const { stableStringify } = require('../util');
const { addConvertedSkills, addFile, addSkillBundle, finalize } = require('./common');

const PLUGIN_NAME = 'buildwithcli-catalog';

const adapter = {
  id: 'hermes',
  displayName: 'Hermes Agent',
  capabilities: {
    skills: { native: true, strategy: 'plugin skills/<name>/SKILL.md via ctx.register_skill' },
    agents: { native: false, strategy: 'agent-to-skill conversion when source tool policy can be represented safely' },
    commands: { native: true, strategy: 'ctx.register_command plus command-to-skill fallback' },
    hooks: { native: true, strategy: 'ctx.register_hook (trusted opt-in)' },
    mcp: { native: true, strategy: 'config.fragment.yaml mcp_servers' },
  },
};

const HERMES_MATCHER_ALIASES = {
  read: ['read_file'], notebookread: ['read_file'], view: ['read_file'], cat: ['read_file'], readfile: ['read_file'],
  write: ['write_file'], writefile: ['write_file'],
  edit: ['patch'], multiedit: ['patch'], notebookedit: ['patch'], applypatch: ['patch'], patch: ['patch'],
  bash: ['terminal'], shell: ['terminal'], execute: ['terminal'], terminal: ['terminal'], powershell: ['terminal'], shell_exec: ['terminal'],
  grep: ['search_files'], search: ['search_files'], find: ['search_files'], glob: ['search_files'], ls: ['search_files'], list: ['search_files'], lsp: ['search_files'],
  webfetch: ['web_extract'], fetch: ['web_extract'], websearch: ['web_search'], web: ['web_search'], browser: ['browser_navigate'],
  task: ['delegate_task'], agent: ['delegate_task'], delegatetask: ['delegate_task'], subagent: ['delegate_task'],
  todowrite: ['todo'], todo: ['todo'], manage_todo_list: ['todo'],
  skill: ['skill_view'], skillview: ['skill_view'], skill_view: ['skill_view'],
};

function hermesMatcherPatterns(matcher) {
  const output = [];
  for (const pattern of matcher.patterns) {
    if (pattern === '*') {
      output.push('*');
      continue;
    }
    if (pattern.includes('*') || pattern.includes('?')) {
      output.push(pattern.toLowerCase());
      continue;
    }
    const aliases = HERMES_MATCHER_ALIASES[normalizedToolKey(pattern)];
    output.push(...(aliases || [pattern.toLowerCase()]));
  }
  return [...new Set(output)];
}

function hermesMcpServer(server) {
  if (server.url) {
    return {
      url: server.url,
      ...(Object.keys(server.headers || {}).length ? { headers: server.headers } : {}),
      ...(server.bearerTokenEnvVar ? { bearer_token_env_var: server.bearerTokenEnvVar } : {}),
      ...(server.startupTimeoutSec != null ? { connect_timeout: server.startupTimeoutSec } : {}),
      ...(server.toolTimeoutSec != null ? { timeout: server.toolTimeoutSec } : {}),
      ...(server.enabled === false ? { enabled: false } : {}),
    };
  }
  return {
    command: server.command,
    ...(server.args?.length ? { args: server.args } : {}),
    ...(server.cwd ? { cwd: server.cwd } : {}),
    ...(Object.keys(server.env || {}).length ? { env: server.env } : {}),
    ...(server.startupTimeoutSec != null ? { connect_timeout: server.startupTimeoutSec } : {}),
    ...(server.toolTimeoutSec != null ? { timeout: server.toolTimeoutSec } : {}),
    ...(server.enabled === false ? { enabled: false } : {}),
  };
}

function configFragment(catalog) {
  const config = { plugins: { enabled: [PLUGIN_NAME] } };
  if (catalog.mcps.length) {
    config.mcp_servers = Object.fromEntries(catalog.mcps.map((server) => [server.name, hermesMcpServer(server)]));
  }
  return stringifyYaml(config);
}

function prepareHooks(hooks, warnings) {
  const result = [];
  for (const hook of hooks) {
    const event = mapHookEvent(hook.event, 'hermes');
    if (!event) {
      warnings.push({ code: 'HOOK_EVENT_UNSUPPORTED', source: hook.sourcePath, message: `Hermes has no safe mapping for ${hook.event}.` });
      continue;
    }
    const matcher = normalizeMatcher(hook.matcher);
    if (!matcher.supported) {
      warnings.push({ code: 'HOOK_MATCHER_UNSUPPORTED', source: hook.sourcePath, message: `Matcher '${hook.matcher}' uses regex syntax that is unsafe to translate automatically.` });
      continue;
    }
    result.push({
      name: hook.name,
      event,
      patterns: hermesMatcherPatterns(matcher),
      command: hook.command,
      command_windows: hook.commandWindows || null,
      cwd: hook.cwd || null,
      env: hook.env || {},
      timeout_sec: Math.min(3600, Math.max(1, Number(hook.timeoutSec || 30))),
    });
  }
  return result;
}

function pluginPython(commands, hooks) {
  return `"""Generated BuildWithCLI catalog plugin for Hermes Agent.\n\nExecutable hooks are included only after explicit compiler trust.\n"""\n\nfrom __future__ import annotations\n\nimport json\nimport os\nimport signal\nimport subprocess\nimport threading\nfrom pathlib import Path\nfrom typing import Any\n\n_PLUGIN_DIR = Path(__file__).resolve().parent\n_COMMANDS = json.loads(${JSON.stringify(JSON.stringify(commands))})\n_HOOKS = json.loads(${JSON.stringify(JSON.stringify(hooks))})\n_MAX_IO = 1024 * 1024\n\n\ndef _safe(value: Any, depth: int = 0) -> Any:\n    if depth > 6:\n        return "<depth-limit>"\n    if value is None or isinstance(value, (str, int, float, bool)):\n        return value\n    if isinstance(value, dict):\n        return {str(k): _safe(v, depth + 1) for k, v in list(value.items())[:1000]}\n    if isinstance(value, (list, tuple)):\n        return [_safe(v, depth + 1) for v in list(value)[:1000]]\n    return str(value)\n\n\ndef _wildcard(pattern: str, value: str) -> bool:\n    import fnmatch\n    return fnmatch.fnmatchcase((value or "").lower(), (pattern or "").lower())\n\n\ndef _matches(patterns: list[str], value: str) -> bool:\n    return not patterns or any(_wildcard(pattern, value) for pattern in patterns)\n\n\ndef _terminate(proc: subprocess.Popen, force: bool = False) -> None:\n    if proc.poll() is not None:\n        return\n    try:\n        if os.name != "nt":\n            os.killpg(proc.pid, signal.SIGKILL if force else signal.SIGTERM)\n        elif force:\n            proc.kill()\n        else:\n            proc.terminate()\n    except Exception:\n        try:\n            proc.kill() if force else proc.terminate()\n        except Exception:\n            pass\n\n\ndef _run_hook(entry: dict[str, Any], payload: dict[str, Any]) -> str:\n    command = entry.get("command_windows") if os.name == "nt" and entry.get("command_windows") else entry["command"]\n    raw_input = json.dumps(_safe(payload), ensure_ascii=False).encode("utf-8")\n    if len(raw_input) > _MAX_IO:\n        raise RuntimeError(f"Hook {entry['name']} input exceeded {_MAX_IO} bytes")\n    base_cwd = os.getcwd()\n    cwd = entry.get("cwd") or base_cwd\n    if not os.path.isabs(cwd):\n        cwd = str((Path(base_cwd) / cwd).resolve())\n    env = os.environ.copy()\n    env.update({str(k): str(v) for k, v in (entry.get("env") or {}).items()})\n    env["BUILDWITHCLI_EVENT"] = entry["event"]\n    env["BUILDWITHCLI_HOOK"] = entry["name"]\n    kwargs = {\n        "args": command, "shell": True, "cwd": cwd, "env": env,\n        "stdin": subprocess.PIPE, "stdout": subprocess.PIPE, "stderr": subprocess.PIPE,\n    }\n    if os.name != "nt":\n        kwargs["start_new_session"] = True\n    proc = subprocess.Popen(**kwargs)\n    stdout_parts: list[bytes] = []\n    stderr_parts: list[bytes] = []\n    state = {"bytes": 0, "overflow": False}\n    lock = threading.Lock()\n\n    def drain(stream, destination):\n        while True:\n            chunk = stream.read(65536)\n            if not chunk:\n                break\n            with lock:\n                state["bytes"] += len(chunk)\n                if state["bytes"] > _MAX_IO:\n                    state["overflow"] = True\n                    _terminate(proc)\n                    break\n                destination.append(chunk)\n\n    out_thread = threading.Thread(target=drain, args=(proc.stdout, stdout_parts), daemon=True)\n    err_thread = threading.Thread(target=drain, args=(proc.stderr, stderr_parts), daemon=True)\n    out_thread.start()\n    err_thread.start()\n    try:\n        try:\n            proc.stdin.write(raw_input)\n            proc.stdin.close()\n        except (BrokenPipeError, OSError):\n            pass\n        try:\n            code = proc.wait(timeout=float(entry.get("timeout_sec") or 30))\n        except subprocess.TimeoutExpired as exc:\n            _terminate(proc)\n            try:\n                proc.wait(timeout=0.75)\n            except subprocess.TimeoutExpired:\n                _terminate(proc, force=True)\n                proc.wait(timeout=1)\n            raise RuntimeError(f"Hook {entry['name']} timed out") from exc\n    finally:\n        out_thread.join(timeout=2)\n        err_thread.join(timeout=2)\n    if state["overflow"]:\n        _terminate(proc, force=True)\n        raise RuntimeError(f"Hook {entry['name']} exceeded {_MAX_IO} output bytes")\n    stdout = b"".join(stdout_parts).decode("utf-8", errors="replace")\n    stderr = b"".join(stderr_parts).decode("utf-8", errors="replace")\n    if code != 0:\n        raise RuntimeError(f"Hook {entry['name']} failed ({code}): {stderr or stdout}")\n    return stdout\n\n\ndef _expand(template: str, raw_args: str) -> str:\n    result = template.replace("$ARGUMENTS", raw_args)\n    parts = raw_args.split()\n    for index in range(9, 0, -1):\n        result = result.replace("$" + str(index), parts[index - 1] if len(parts) >= index else "")\n    return result\n\n\ndef register(ctx):\n    skills_dir = _PLUGIN_DIR / "skills"\n    if skills_dir.is_dir():\n        for child in sorted(skills_dir.iterdir(), key=lambda item: item.name):\n            skill_md = child / "SKILL.md"\n            if child.is_dir() and skill_md.is_file():\n                ctx.register_skill(child.name, skill_md)\n\n    for command in _COMMANDS:\n        def handler(raw_args: str, item=command):\n            prompt = _expand(item["prompt"], raw_args or "")\n            try:\n                if ctx.inject_message(prompt):\n                    return None\n            except Exception:\n                pass\n            return prompt\n        ctx.register_command(\n            command["name"], handler,\n            description=command["description"], args_hint=command.get("args_hint", ""),\n        )\n\n    for entry in _HOOKS:\n        def callback(*args, _entry=entry, **kwargs):\n            tool_name = str(kwargs.get("tool_name") or (args[0] if args else ""))\n            if _entry["event"] in {"pre_tool_call", "post_tool_call"} and not _matches(_entry.get("patterns") or [], tool_name):\n                return None\n            output = _run_hook(_entry, {"args": _safe(args), "kwargs": _safe(kwargs)})\n            if _entry["event"] == "pre_llm_call" and output.strip():\n                return {"context": output[:_MAX_IO]}\n            return None\n        ctx.register_hook(entry["event"], callback)\n`;
}

function installMarkdown() {
  return `# Install in Hermes Agent\n\n1. Copy this directory to \`~/.hermes/plugins/${PLUGIN_NAME}\`.\n2. Merge \`config.fragment.yaml\` into \`~/.hermes/config.yaml\`.\n3. Run \`hermes plugins enable ${PLUGIN_NAME}\` (or retain the generated \`plugins.enabled\` entry).\n4. Restart Hermes and verify with \`/plugins\`.\n\nProject plugins can instead live at \`.hermes/plugins/${PLUGIN_NAME}\` when \`HERMES_ENABLE_PROJECT_PLUGINS\` is explicitly enabled.\n`;
}

function omittedAgentMarkdown(entity) {
  return [
    `# Omitted Hermes agent: ${entity.name}`,
    '',
    `Source: \`${entity.sourcePath}\``,
    '',
    'This source agent declares an explicit empty tool allow-list. A Hermes plugin skill is procedural guidance, not an isolated deny-all subagent sandbox, so BuildWithCLI intentionally did not emit an executable converted skill.',
    '',
    '## Original instructions',
    '',
    entity.body || entity.description,
    '',
  ].join('\n');
}

async function render(catalog, options = {}) {
  const files = new Map();
  const warnings = [];
  const degradations = [];
  const executableAgents = [];
  const omittedAgents = [];

  for (const entity of catalog.agents) {
    const tools = sourceTools(entity);
    if (tools.specified && tools.raw.length === 0) omittedAgents.push(entity);
    else executableAgents.push(entity);
    if (tools.specified && tools.raw.length > 0) warnings.push({
      code: 'HERMES_AGENT_TOOL_POLICY_ADVISORY',
      source: entity.sourcePath,
      message: `Hermes plugin skills preserve the source tool list (${tools.raw.join(', ')}) as metadata and instructions, but do not create an isolated per-skill tool sandbox.`,
    });
  }

  for (const skill of catalog.skills) addSkillBundle(files, skill, 'skills', 'hermes');
  addConvertedSkills(files, { ...catalog, agents: executableAgents }, 'skills', 'hermes', { warnings, includeInvocationFields: false });
  for (const entity of omittedAgents) {
    addFile(files, `unsupported/agents/${entity.name}.md`, omittedAgentMarkdown(entity), entity.sourcePath);
    warnings.push({
      code: 'HERMES_AGENT_OMITTED_DENY_ALL',
      source: entity.sourcePath,
      message: 'Explicit deny-all agent was documented but not emitted as an executable Hermes skill because Hermes skills cannot enforce an isolated empty tool set.',
    });
  }

  const commands = catalog.commands.map((entity) => ({
    name: entity.name,
    description: entity.description,
    args_hint: commandArgumentHint(entity),
    prompt: entity.body,
  }));
  let hooks = [];
  if (options.includeHooks) {
    hooks = prepareHooks(catalog.hooks, warnings);
    if (hooks.length) degradations.push({
      code: 'HERMES_HOOK_SEMANTICS',
      message: 'Hermes plugin hooks are observers except pre_llm_call context injection. A failing pre-tool hook is logged by Hermes and may not veto execution; use native approval policy for enforcement.',
    });
  } else if (catalog.hooks.length) {
    warnings.push({ code: 'HOOKS_DISABLED', message: `${catalog.hooks.length} executable hooks were not emitted; rerun with --hooks trusted --trust-hooks after review.` });
  }

  const mappedHookNames = [...new Set(hooks.map((hook) => hook.event))].sort();
  addFile(files, 'plugin.yaml', stringifyYaml({
    name: PLUGIN_NAME,
    version: '1.0.0',
    description: 'Portable BuildWithCLI skills, workflows, and integrations',
    ...(mappedHookNames.length ? { provides_hooks: mappedHookNames } : {}),
  }), 'generated:manifest');
  addFile(files, '__init__.py', pluginPython(commands, hooks), 'generated:plugin');
  addFile(files, 'data/commands.json', stableStringify(commands), 'generated:commands');
  if (hooks.length) addFile(files, 'data/hooks.json', stableStringify(hooks), 'generated:hooks');
  addFile(files, 'config.fragment.yaml', configFragment(catalog), 'generated:config');
  addFile(files, 'INSTALL.md', installMarkdown(), 'generated:docs');

  if (omittedAgents.length) degradations.push({
    code: 'HERMES_DENY_ALL_AGENT_OMITTED',
    message: `${omittedAgents.length} explicit deny-all agent(s) were documented under unsupported/agents instead of being widened into executable skills.`,
  });
  if (catalog.commands.length) degradations.push({
    code: 'COMMAND_DISPATCH_FALLBACK',
    message: 'Hermes slash handlers inject the workflow as a user message when the interactive host permits it; gateway contexts fall back to returning the expanded prompt. Every command is also exported as a skill.',
  });
  return finalize(files, 'hermes', catalog, adapter, warnings, degradations, options);
}

module.exports = { HERMES_MATCHER_ALIASES, PLUGIN_NAME, adapter, configFragment, hermesMatcherPatterns, hermesMcpServer, pluginPython, prepareHooks, render };
