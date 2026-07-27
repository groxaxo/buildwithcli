'use strict';

const {
  assert, fs, fsp, os, path, test, TARGETS, applyProjection,
  buildProjectionPlan, buildAllowedRootsByTarget, discoverCatalog,
  loadTargetProfiles, manifestPathFor, parseFrontmatter,
  resolveRequestedTargets, rewriteCommandArguments, fitSkillName,
  selectResources, stringifyFrontmatter, uninstallProjection, makeTemp, write,
  createCatalog, context, invokeCli,
} = require('./helpers');

test('frontmatter emitter produces valid nested YAML without relying on dependencies', () => {
  const rendered = stringifyFrontmatter({
    permission: { '*': 'deny', read: 'allow' },
    tools: ['read', 'edit'],
    metadata: { source: 'plugins/example.md' },
  }, 'Body');
  assert.match(rendered, /"\*": deny/);
  assert.match(rendered, /tools: \[read, edit\]/);
  assert.deepEqual(parseFrontmatter(rendered).data, {
    permission: { '*': 'deny', read: 'allow' },
    tools: ['read', 'edit'],
    metadata: { source: 'plugins/example.md' },
  });
});

test('catalog discovery prefers aggregate resources and reports conflicting duplicates', async (t) => {
  const { catalog } = await createCatalog(t);
  const result = await discoverCatalog(catalog);
  assert.equal(result.resources.length, 3);
  const agent = result.resources.find((resource) => resource.kind === 'agent');
  assert.equal(agent.sourcePath, 'plugins/all-agents/agents/python-expert.md');
  assert.equal(result.conflicts.length, 1);
  await assert.rejects(() => discoverCatalog(catalog, { strict: true }), (error) => {
    assert.equal(error.code, 'CATALOG_CONFLICT');
    return true;
  });
});

test('selectors support kind prefixes, globs, exclusions, and kind filters', async (t) => {
  const { catalog } = await createCatalog(t);
  const { resources } = await discoverCatalog(catalog);
  assert.deepEqual(selectResources(resources, ['agent:python-*']).map((resource) => resource.name), ['python-expert']);
  assert.deepEqual(selectResources(resources, ['*'], { exclude: ['command:*'] }).map((resource) => resource.kind), ['skill', 'agent']);
  assert.deepEqual(selectResources(resources, [], { kinds: ['skill'] }).map((resource) => resource.name), ['review']);
});

test('all-target projection uses native paths, shared commands, and one portable skill tree', async (t) => {
  const { catalog, project, home } = await createCatalog(t);
  const discovered = await discoverCatalog(catalog);
  const targetIds = ['opencode', 'hermes', 'codex', 'copilot', 'claude', 'agents'];
  const plan = await buildProjectionPlan({
    resources: discovered.resources,
    targetIds,
    targets: TARGETS,
    scope: 'project',
    context: context(project, home),
  });

  const destinations = plan.operations.map((operation) => path.relative(project, operation.destination));
  assert.ok(destinations.includes('.opencode/agents/python-expert.md'));
  assert.ok(destinations.includes('.opencode/commands/commit.md'));
  assert.ok(destinations.includes('.github/agents/python-expert.agent.md'));
  assert.ok(destinations.includes('.claude/commands/commit.md'));
  assert.ok(destinations.includes('.agents/skills/commit/SKILL.md'));
  assert.equal(destinations.filter((destination) => destination === '.agents/skills/commit/SKILL.md').length, 1);

  const portable = plan.operations.find((operation) => destinationEnds(operation, '.agents/skills/commit/SKILL.md'));
  assert.deepEqual(portable.targetIds.sort(), ['agents', 'codex', 'hermes']);
  assert.match(portable.content.toString(), /complete arguments supplied with this invocation/);
  assert.match(portable.content.toString(), /first supplied argument/);

  const openCode = plan.operations.find((operation) => destinationEnds(operation, '.opencode/agents/python-expert.md'));
  const openCodeData = parseFrontmatter(openCode.content.toString()).data;
  assert.deepEqual(openCodeData.permission, { '*': 'deny', read: 'allow', edit: 'allow', bash: 'allow' });

  const copilot = plan.operations.find((operation) => destinationEnds(operation, '.github/agents/python-expert.agent.md'));
  const copilotData = parseFrontmatter(copilot.content.toString()).data;
  assert.deepEqual(copilotData.tools, ['read', 'edit', 'execute', 'WeirdVendorTool']);
  assert.ok(plan.warnings.some((warning) => warning.warning.includes('Unmapped OpenCode tools')));
  assert.ok(plan.warnings.some((warning) => warning.warning.includes('Copilot will ignore')));
});

function destinationEnds(operation, suffix) {
  return operation.destination.split(path.sep).join('/').endsWith(suffix);
}

test('same names across resource kinds receive deterministic skill names', async (t) => {
  const { catalog, project, home } = await createCatalog(t, { sameNameAcrossKinds: true });
  const discovered = await discoverCatalog(catalog);
  const plan = await buildProjectionPlan({
    resources: discovered.resources,
    targetIds: ['codex'],
    targets: TARGETS,
    scope: 'project',
    context: context(project, home),
  });
  const names = plan.operations
    .filter((operation) => operation.destination.endsWith('SKILL.md'))
    .map((operation) => operation.outputName)
    .sort();
  assert.deepEqual(names, ['agent-review', 'command-review', 'commit', 'python-expert', 'review']);
});


test('portable output names stay within the Agent Skills 64-character limit', () => {
  const long = 'command-' + 'a'.repeat(64);
  const fitted = fitSkillName(long);
  assert.ok(fitted.length <= 64);
  assert.match(fitted, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.equal(fitted, fitSkillName(long));
  assert.notEqual(fitted, fitSkillName(`${long}-different`));
});

test('command arguments are converted without leaking vendor placeholders', () => {
  assert.equal(
    rewriteCommandArguments('Use $ARGUMENTS, ${ARGUMENTS}, $1 and $2.'),
    'Use the complete arguments supplied with this invocation, the complete arguments supplied with this invocation, the first supplied argument and the second supplied argument.',
  );
});
