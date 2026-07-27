'use strict';

const {
  assert, fs, fsp, os, path, test, TARGETS, applyProjection,
  buildProjectionPlan, buildAllowedRootsByTarget, discoverCatalog,
  loadTargetProfiles, manifestPathFor, parseFrontmatter,
  resolveRequestedTargets, rewriteCommandArguments, fitSkillName,
  selectResources, stringifyFrontmatter, uninstallProjection, makeTemp, write,
  createCatalog, context, invokeCli,
} = require('./helpers');

test('transactional install supports create, noop, tracked update, conflict, and force', async (t) => {
  const { catalog, project, home } = await createCatalog(t);
  const ctx = context(project, home);
  const manifestPath = manifestPathFor('project', ctx);

  async function makePlan() {
    const discovered = await discoverCatalog(catalog);
    return buildProjectionPlan({
      resources: selectResources(discovered.resources, ['skill:review']),
      targetIds: ['agents'],
      targets: TARGETS,
      scope: 'project',
      context: ctx,
    });
  }

  let result = await applyProjection(await makePlan(), { manifestPath, manifestBoundaryRoot: project });
  assert.deepEqual(result.statuses.map((item) => item.status), ['create', 'create']);
  result = await applyProjection(await makePlan(), { manifestPath, manifestBoundaryRoot: project });
  assert.deepEqual(result.statuses.map((item) => item.status), ['noop', 'noop']);

  const source = path.join(catalog, 'plugins/all-skills/skills/review/SKILL.md');
  await fsp.appendFile(source, '\nUpdated source instructions.\n');
  result = await applyProjection(await makePlan(), { manifestPath, manifestBoundaryRoot: project });
  assert.ok(result.statuses.some((item) => item.status === 'update'));

  const destination = path.join(project, '.agents/skills/review/SKILL.md');
  await fsp.appendFile(destination, '\nLocal modification.\n');
  await assert.rejects(
    async () => applyProjection(await makePlan(), { manifestPath, manifestBoundaryRoot: project }),
    (error) => error.code === 'DESTINATION_CONFLICT',
  );
  result = await applyProjection(await makePlan(), { manifestPath, manifestBoundaryRoot: project, force: true });
  assert.ok(result.statuses.some((item) => item.status === 'update'));
  assert.doesNotMatch(await fsp.readFile(destination, 'utf8'), /Local modification/);
});


test('identical untracked files are not silently adopted without force', async (t) => {
  const { catalog, project, home } = await createCatalog(t);
  const ctx = context(project, home);
  const discovered = await discoverCatalog(catalog);
  const plan = await buildProjectionPlan({
    resources: selectResources(discovered.resources, ['skill:review']),
    targetIds: ['agents'],
    targets: TARGETS,
    scope: 'project',
    context: ctx,
  });
  const operation = plan.operations.find((item) => item.destination.endsWith('SKILL.md'));
  await write(project, path.relative(project, operation.destination), operation.content);
  const manifestPath = manifestPathFor('project', ctx);

  await assert.rejects(
    () => applyProjection(plan, { manifestPath, manifestBoundaryRoot: project }),
    (error) => error.code === 'DESTINATION_CONFLICT',
  );
  const result = await applyProjection(plan, { manifestPath, manifestBoundaryRoot: project, force: true });
  assert.ok(result.statuses.some((item) => item.status === 'update'));
});

test('mode-only local changes are protected during install and uninstall', async (t) => {
  const { catalog, project, home } = await createCatalog(t);
  const ctx = context(project, home);
  const discovered = await discoverCatalog(catalog);
  const plan = await buildProjectionPlan({
    resources: selectResources(discovered.resources, ['command:commit']),
    targetIds: ['codex'],
    targets: TARGETS,
    scope: 'project',
    context: ctx,
  });
  const manifestPath = manifestPathFor('project', ctx);
  await applyProjection(plan, { manifestPath, manifestBoundaryRoot: project });
  const destination = path.join(project, '.agents/skills/commit/SKILL.md');
  await fsp.chmod(destination, 0o600);

  await assert.rejects(
    () => applyProjection(plan, { manifestPath, manifestBoundaryRoot: project }),
    (error) => error.code === 'DESTINATION_CONFLICT',
  );
  await assert.rejects(
    () => uninstallProjection({ manifestPath, manifestBoundaryRoot: project }),
    (error) => error.code === 'UNINSTALL_CONFLICT',
  );
});

test('shared target uninstall detaches ownership before removing physical files', async (t) => {
  const { catalog, project, home } = await createCatalog(t);
  const ctx = context(project, home);
  const discovered = await discoverCatalog(catalog);
  const plan = await buildProjectionPlan({
    resources: selectResources(discovered.resources, ['skill:review']),
    targetIds: ['agents', 'codex', 'hermes'],
    targets: TARGETS,
    scope: 'project',
    context: ctx,
  });
  const manifestPath = manifestPathFor('project', ctx);
  await applyProjection(plan, { manifestPath, manifestBoundaryRoot: project });

  let result = await uninstallProjection({
    manifestPath,
    manifestBoundaryRoot: project,
    targetIds: ['codex'],
    selectors: ['skill:review'],
  });
  assert.ok(result.statuses.every((item) => item.status === 'detach'));
  assert.ok(fs.existsSync(path.join(project, '.agents/skills/review/SKILL.md')));
  assert.deepEqual(result.manifest.entries[0].targetIds, ['agents', 'hermes']);

  result = await uninstallProjection({
    manifestPath,
    manifestBoundaryRoot: project,
    targetIds: ['agents', 'hermes'],
    selectors: ['skill:review'],
  });
  assert.ok(result.statuses.every((item) => item.status === 'remove'));
  assert.equal(result.manifest.entries.length, 0);
  assert.equal(fs.existsSync(path.join(project, '.agents/skills/review/SKILL.md')), false);
});

test('uninstall protects local modifications unless force is explicit', async (t) => {
  const { catalog, project, home } = await createCatalog(t);
  const ctx = context(project, home);
  const discovered = await discoverCatalog(catalog);
  const plan = await buildProjectionPlan({
    resources: selectResources(discovered.resources, ['command:commit']),
    targetIds: ['codex'],
    targets: TARGETS,
    scope: 'project',
    context: ctx,
  });
  const manifestPath = manifestPathFor('project', ctx);
  await applyProjection(plan, { manifestPath, manifestBoundaryRoot: project });
  const destination = path.join(project, '.agents/skills/commit/SKILL.md');
  await fsp.appendFile(destination, '\nlocal edit\n');

  await assert.rejects(
    () => uninstallProjection({ manifestPath, manifestBoundaryRoot: project }),
    (error) => error.code === 'UNINSTALL_CONFLICT',
  );
  const result = await uninstallProjection({ manifestPath, manifestBoundaryRoot: project, force: true });
  assert.equal(result.statuses[0].status, 'remove');
  assert.equal(fs.existsSync(destination), false);
});

test('source and project destination symlink escapes are rejected', async (t) => {
  const { catalog, project, home, root } = await createCatalog(t);
  const outside = path.join(root, 'outside');
  await fsp.mkdir(outside);

  const sourceLink = path.join(catalog, 'plugins/all-skills/skills/review/reference/link');
  await fsp.symlink(outside, sourceLink, 'dir');
  await assert.rejects(() => discoverCatalog(catalog), (error) => error.code === 'SOURCE_SYMLINK');
  await fsp.rm(sourceLink);

  const discovered = await discoverCatalog(catalog);
  const plan = await buildProjectionPlan({
    resources: selectResources(discovered.resources, ['skill:review']),
    targetIds: ['agents'],
    targets: TARGETS,
    scope: 'project',
    context: context(project, home),
  });
  await fsp.symlink(outside, path.join(project, '.agents'), 'dir');
  await assert.rejects(
    () => applyProjection(plan, {
      manifestPath: path.join(project, '.buildwithcli/manifest.json'),
      manifestBoundaryRoot: project,
    }),
    (error) => ['TARGET_ROOT_SYMLINK_ESCAPE', 'DESTINATION_SYMLINK_ESCAPE'].includes(error.code),
  );
  assert.equal((await fsp.readdir(outside)).length, 0);
});

test('tampered manifests cannot uninstall paths outside their recorded root', async (t) => {
  const { project, root } = await createCatalog(t);
  const outside = await write(root, 'outside.txt', 'do not delete\n');
  const manifestPath = path.join(project, '.buildwithcli/manifest.json');
  await write(project, '.buildwithcli/manifest.json', `${JSON.stringify({
    version: 1,
    entries: [{
      targetIds: ['agents'],
      sourceKind: 'skill',
      sourceName: 'evil',
      outputName: 'evil',
      sourcePath: 'plugins/evil/SKILL.md',
      root: path.join(project, '.agents/skills'),
      boundaryRoot: project,
      scope: 'project',
      destination: outside,
      sha256: '0'.repeat(64),
      mode: 0o644,
      format: 'portable-skill',
    }],
  }, null, 2)}\n`);
  await assert.rejects(
    () => uninstallProjection({ manifestPath, manifestBoundaryRoot: project, force: true }),
    (error) => error.code === 'UNSAFE_DESTINATION',
  );
  assert.equal(await fsp.readFile(outside, 'utf8'), 'do not delete\n');
});


test('user manifests are validated against current target roots before uninstall', async (t) => {
  const { catalog, project, home, root } = await createCatalog(t);
  const environment = { PATH: '', XDG_CONFIG_HOME: path.join(root, 'xdg') };
  const ctx = context(project, home, environment);
  const discovered = await discoverCatalog(catalog);
  const plan = await buildProjectionPlan({
    resources: selectResources(discovered.resources, ['skill:review']),
    targetIds: ['opencode'],
    targets: TARGETS,
    scope: 'user',
    context: ctx,
  });
  const manifestPath = manifestPathFor('user', ctx);
  const allowedRootsByTarget = buildAllowedRootsByTarget(TARGETS, 'user', ctx);
  await applyProjection(plan, {
    manifestPath,
    manifestBoundaryRoot: home,
    allowedRootsByTarget,
  });

  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  manifest.entries[0].root = root;
  manifest.entries[0].destination = path.join(root, 'untrusted.md');
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await write(root, 'untrusted.md', 'keep\n');

  await assert.rejects(
    () => uninstallProjection({
      manifestPath,
      manifestBoundaryRoot: home,
      allowedRootsByTarget,
      force: true,
    }),
    (error) => error.code === 'UNTRUSTED_MANIFEST_ROOT',
  );
  assert.equal(await fsp.readFile(path.join(root, 'untrusted.md'), 'utf8'), 'keep\n');
});
