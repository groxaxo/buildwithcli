#!/usr/bin/env node
'use strict';

const { BuildWithCliError, runCli } = require('../lib/buildwithcli');

runCli().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error) => {
    if (error instanceof BuildWithCliError) {
      process.stderr.write(`buildwithcli: ${error.message}\n`);
      if (error.details && process.env.BUILDWITHCLI_DEBUG === '1') {
        process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
      }
      process.exitCode = error.exitCode;
      return;
    }
    process.stderr.write(`buildwithcli: unexpected error: ${error?.stack || error}\n`);
    process.exitCode = 1;
  },
);
