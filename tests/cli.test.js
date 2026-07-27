'use strict';

const {
  assert, fs, fsp, os, path, test, TARGETS, applyProjection,
  buildProjectionPlan, buildAllowedRootsByTarget, discoverCatalog,
  loadTargetProfiles, manifestPathFor, parseFrontmatter,
  resolveRequestedTargets, rewriteCommandArguments, fitSkillName,
  selectResources, stringifyFrontmatter, uninstallProjection, makeTemp, write,
  createCatalog, context, invokeCli,
} = require('./helpers');

test('custom profiles can support one scope and reject escaping project roots', async (t) => {
  const root = await makeTemp(t);
  const validPath = await write(root, 'valid.json', JSON.stringify({
    id: 'mycli',
    displayName: 'My CLI',
    binaries: ['mycli'],
    project: {
      roots: { skill: '.mycli/skills' },
      formats: { agent: 'portable-skill', command: 'portable-skill', skill: 'portable-skill' },
    },
  }));
  const targets = await loadTargetProfiles([validPath]);
  assert.equal(targets.mycli.user, undefined);

  const invalidPath = await write(root, 'invalid.json', JSON.stringify({
    id: 'escape',
    project: {
      roots: { skill: '../outside' },
      formats: { skill: 'portable-skill' },
    },
  }));
  const invalidTargets = await loadTargetProfiles([invalidPath]);
  const fixture = await createCatalog(t);
  const discovered = await discoverCatalog(fixture.catalog);
  await assert.rejects(
    () => buildProjectionPlan({
      resources: selectResources(discovered.resources, ['skill:review']),
      targetIds: ['escape'],
      targets: invalidTargets,
      scope: 'project',
      context: context(fixture.project, fixture.home),
    }),
    (error) => error.code === 'UNSAFE_TARGET_ROOT',
  );
});

test('auto target detection honors available binaries and falls back to generic skills', async (t) => {
  const root = await makeTemp(t);
  const bin = path.join(root, 'bin');
  await fsp.mkdir(bin);
  await write(bin, 'opencode', '#!/bin/sh\n', 0o755);
  await write(bin, 'codex', '#!/bin/sh\n', 0o755);
  const detected = resolveRequestedTargets(['auto'], TARGETS, { PATH: bin });
  assert.deepEqual(detected, ['opencode', 'codex']);
  assert.deepEqual(resolveRequestedTargets(['auto'], TARGETS, { PATH: '' }), ['agents']);
});


test('top-level help and version flags are parsed without an explicit command', async () => {
  let result = await invokeCli(['--version'], { cwd: process.cwd(), home: os.homedir(), environment: { PATH: '' } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), '1.0.0');

  result = await invokeCli(['--help'], { cwd: process.cwd(), home: os.homedir(), environment: { PATH: '' } });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^BuildWithCLI 1\.0\.0/);
  assert.match(result.stdout, /buildwithcli install/);
});

test('CLI export defaults to all built-in targets and stays inside output', async (t) => {
  const { catalog, project, home, root } = await createCatalog(t);
  const output = path.join(root, 'export');
  const result = await invokeCli([
    'export', 'skill:review', '--catalog', catalog, '--project', project, '--output', output, '--json',
  ], { cwd: project, home, environment: { PATH: '' } });
  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.targets, ['opencode', 'hermes', 'codex', 'copilot', 'claude', 'agents']);
  assert.ok(fs.existsSync(path.join(output, '.opencode/skills/review/SKILL.md')));
  assert.ok(fs.existsSync(path.join(output, '.github/skills/review/SKILL.md')));
  assert.ok(fs.existsSync(path.join(output, '.agents/skills/review/SKILL.md')));
  assert.ok(parsed.plan.operations.every((operation) => operation.destination.startsWith(output)));
});

test('Hermes doctor reports the required project external directory configuration', async (t) => {
  const { catalog, project, home } = await createCatalog(t);
  let result = await invokeCli([
    'doctor', '--catalog', catalog, '--project', project, '--target', 'hermes', '--skip-binary-check', '--json',
  ], { cwd: project, home, environment: { PATH: '' } });
  assert.equal(result.exitCode, 0);
  let doctor = JSON.parse(result.stdout);
  assert.equal(doctor.hermesExternal[0].configured, false);

  await write(home, '.hermes/config.yaml', `skills:\n  external_dirs:\n    - ${path.join(project, '.agents/skills')}\n`);
  result = await invokeCli([
    'doctor', '--catalog', catalog, '--project', project, '--target', 'hermes', '--skip-binary-check', '--json',
  ], { cwd: project, home, environment: { PATH: '' } });
  doctor = JSON.parse(result.stdout);
  assert.equal(doctor.hermesExternal[0].configured, true);
});

test('user-scope roots honor HOME, XDG_CONFIG_HOME, HERMES_HOME, and COPILOT_HOME', async (t) => {
  const { catalog, project, home, root } = await createCatalog(t);
  const xdg = path.join(root, 'xdg');
  const hermesHome = path.join(root, 'hermes-profile');
  const copilotHome = path.join(root, 'copilot-profile');
  const environment = { PATH: '', XDG_CONFIG_HOME: xdg, HERMES_HOME: hermesHome, COPILOT_HOME: copilotHome };
  const result = await invokeCli([
    'install', 'skill:review', '--catalog', catalog, '--project', project, '--scope', 'user', '--target', 'opencode,hermes,codex,copilot', '--json',
  ], { cwd: project, home, environment });
  assert.equal(result.exitCode, 0);
  assert.ok(fs.existsSync(path.join(xdg, 'opencode/skills/review/SKILL.md')));
  assert.ok(fs.existsSync(path.join(hermesHome, 'skills/review/SKILL.md')));
  assert.ok(fs.existsSync(path.join(home, '.agents/skills/review/SKILL.md')));
  assert.ok(fs.existsSync(path.join(copilotHome, 'skills/review/SKILL.md')));
  assert.ok(fs.existsSync(path.join(home, '.buildwithcli/manifest.json')));
});
