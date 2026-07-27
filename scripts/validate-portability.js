#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { validate } = require('../lib/portable/compiler');

async function main() {
  const source = path.resolve(process.cwd());
  const result = await validate({
    source,
    profile: process.env.BUILDWITHCLI_PROFILE || 'curated',
    strict: true,
  });
  const counts = result.catalog.counts;
  console.log('\nBuildWithCLI portability validation');
  console.log('='.repeat(50));
  console.log(`Catalog: ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(' ')}`);
  for (const target of result.rendered) {
    console.log(`  ✓ ${target.target}: ${target.files} files, ${target.report.warnings.length} warnings, ${target.report.degradations.length} declared degradations`);
  }
  console.log('\n✓ Every built-in target rendered successfully with executable hooks disabled.');
}

main().catch((error) => {
  console.error(`\n✗ BuildWithCLI portability validation failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
