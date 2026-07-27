#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const installedRoot = path.join(root, 'portability-tests');
const overlayRoot = path.join(root, 'tests');
const testRoot = fs.existsSync(installedRoot) ? installedRoot : overlayRoot;
const tests = fs.readdirSync(testRoot)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(testRoot, name));
if (!tests.length) {
  console.error(`No portability tests found under ${testRoot}`);
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ['--test', ...tests], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    console.error(`Cannot run portability tests: ${result.error.message}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
