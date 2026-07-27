'use strict';

const claude = require('./claude');
const codex = require('./codex');
const copilot = require('./copilot');
const hermes = require('./hermes');
const opencode = require('./opencode');
const universal = require('./universal');
const custom = require('./custom');

const BUILTIN_ADAPTERS = new Map([
  [opencode.adapter.id, opencode],
  [hermes.adapter.id, hermes],
  [codex.adapter.id, codex],
  [copilot.adapter.id, copilot],
  [claude.adapter.id, claude],
  [universal.adapter.id, universal],
]);

function getAdapter(id) {
  const adapter = BUILTIN_ADAPTERS.get(String(id || '').toLowerCase());
  if (!adapter) throw new Error(`Unknown target '${id}'. Valid targets: ${[...BUILTIN_ADAPTERS.keys()].join(', ')}, custom, all`);
  return adapter;
}

function listTargets() {
  return [...BUILTIN_ADAPTERS.values()].map((module) => module.adapter);
}

module.exports = { BUILTIN_ADAPTERS, custom, getAdapter, listTargets };
