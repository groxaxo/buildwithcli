'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  TARGETS,
  applyProjection,
  buildProjectionPlan,
  buildAllowedRootsByTarget,
  discoverCatalog,
  loadTargetProfiles,
  manifestPathFor,
  parseFrontmatter,
  resolveRequestedTargets,
  rewriteCommandArguments,
  fitSkillName,
  runCli,
  selectResources,
  stringifyFrontmatter,
  uninstallProjection,
} = require('../lib/buildwithcli');

async function makeTemp(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'buildwithcli-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function write(root, relative, content, mode = 0o644) {
  const destination = path.join(root, relative);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.writeFile(destination, content, { mode });
  await fsp.chmod(destination, mode);
  return destination;
}

async function createCatalog(t, options = {}) {
  const root = await makeTemp(t);
  const catalog = path.join(root, 'catalog');
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  await Promise.all([fsp.mkdir(catalog), fsp.mkdir(project), fsp.mkdir(home)]);

  await write(catalog, 'plugins/all-agents/agents/python-expert.md', `---
name: python-expert
description: Primary Python expert for implementation and review.
category: language-specialists
tools: Read, Write, Bash, WeirdVendorTool
---
You are the primary Python expert.
`);
  await write(catalog, 'plugins/agents-language-specialists/agents/python-expert.md', `---
name: python-expert
description: Secondary duplicate that should not win.
category: language-specialists
---
Secondary body.
`);
  await write(catalog, 'plugins/commands-version-control-git/commands/commit.md', `---
description: Create a verified conventional commit.
category: version-control-git
argument-hint: '[--no-verify]'
allowed-tools: Bash, Read, Glob
---
# Claude Command: Commit
Use $ARGUMENTS and inspect $1 before committing.
`);
  await write(catalog, 'plugins/all-skills/skills/review/SKILL.md', `---
name: review
description: Review current changes and report correctness, security, and test gaps.
category: testing-qa
license: MIT
---
# Review
Read reference/checklist.md and review the changes.
`);
  await write(catalog, 'plugins/all-skills/skills/review/reference/checklist.md', 'Checklist\n');

  if (options.sameNameAcrossKinds) {
    await write(catalog, 'plugins/commands-misc/commands/review.md', `---
description: Run the review command over supplied input.
category: miscellaneous
---
Review $ARGUMENTS.
`);
    await write(catalog, 'plugins/all-agents/agents/review.md', `---
name: review
description: Review specialist agent.
category: quality-security
---
You are a review specialist.
`);
  }

  return { root, catalog, project, home };
}

function context(projectRoot, home, environment = {}) {
  return { projectRoot, home, environment: { PATH: '', ...environment } };
}

function captureStream() {
  let value = '';
  return {
    write(chunk) { value += String(chunk); },
    text() { return value; },
  };
}

async function invokeCli(args, options) {
  const stdout = captureStream();
  const stderr = captureStream();
  const exitCode = await runCli(args, { ...options, stdout, stderr });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

module.exports = {
  assert, fs, fsp, os, path, test, TARGETS, applyProjection,
  buildProjectionPlan, buildAllowedRootsByTarget, discoverCatalog,
  loadTargetProfiles, manifestPathFor, parseFrontmatter,
  resolveRequestedTargets, rewriteCommandArguments, fitSkillName, runCli,
  selectResources, stringifyFrontmatter, uninstallProjection, makeTemp, write,
  createCatalog, context, captureStream, invokeCli,
};
