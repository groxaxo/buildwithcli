'use strict';

const base = require('./base');
const yaml = require('./yaml');
const names = require('./names');
const catalog = require('./catalog');
const targets = require('./targets');
const render = require('./render');
const manifest = require('./manifest');
const transaction = require('./transaction');
const cli = require('./cli');

module.exports = {
  VERSION: base.VERSION,
  TARGETS: base.TARGETS,
  BuildWithCliError: base.BuildWithCliError,
  parseFrontmatter: yaml.parseFrontmatter,
  stringifyFrontmatter: yaml.stringifyFrontmatter,
  parseToolList: yaml.parseToolList,
  mapTools: names.mapTools,
  discoverCatalog: catalog.discoverCatalog,
  selectResources: catalog.selectResources,
  loadTargetProfiles: targets.loadTargetProfiles,
  resolveRequestedTargets: targets.resolveRequestedTargets,
  resolveFormatRoot: targets.resolveFormatRoot,
  renderSkillMain: render.renderSkillMain,
  renderOpenCodeAgent: render.renderOpenCodeAgent,
  renderOpenCodeCommand: render.renderOpenCodeCommand,
  renderCopilotAgent: render.renderCopilotAgent,
  renderCopilotCommand: render.renderCopilotCommand,
  renderSharedCommand: render.renderSharedCommand,
  buildProjectionPlan: render.buildProjectionPlan,
  preflightProjection: manifest.preflightProjection,
  applyProjection: transaction.applyProjection,
  uninstallProjection: transaction.uninstallProjection,
  manifestPathFor: manifest.manifestPathFor,
  buildAllowedRootsByTarget: manifest.buildAllowedRootsByTarget,
  runDoctor: cli.runDoctor,
  runCli: cli.runCli,
  sha256: base.sha256,
  isPathInside: render.isPathInside,
  compactHermesDescription: names.compactHermesDescription,
  rewriteCommandArguments: render.rewriteCommandArguments,
  fitSkillName: names.fitSkillName,
};
