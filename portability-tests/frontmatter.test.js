'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFrontmatter, parseYamlSubset, stringifyFrontmatter, stringifyYaml } = require('../lib/portable/frontmatter');
const { parseJsonc } = require('../lib/portable/util');

test('safe YAML subset parses nested values and round-trips generated metadata', () => {
  const source = `name: demo\ndescription: Test\ntools:\n  - Read\n  - Bash\nmetadata:\n  owner: platform\nnotes: |-\n  line one\n  line two\n`;
  const parsed = parseYamlSubset(source);
  assert.deepEqual(parsed.tools, ['Read', 'Bash']);
  assert.equal(parsed.metadata.owner, 'platform');
  assert.equal(parsed.notes, 'line one\nline two');
  assert.deepEqual(parseYamlSubset(stringifyYaml(parsed)), parsed);

  const markdown = stringifyFrontmatter(parsed, '# Body\n');
  const roundTrip = parseFrontmatter(markdown);
  assert.deepEqual(roundTrip.data, parsed);
  assert.equal(roundTrip.body.trim(), '# Body');
});

test('safe YAML subset rejects duplicate keys, indentation tabs, aliases, and tags', () => {
  assert.throws(() => parseYamlSubset('name: one\nname: two\n'), /Duplicate YAML key/);
  assert.throws(() => parseYamlSubset('name:\n\tchild: bad\n'), /Tabs are not allowed/);
  assert.throws(() => parseYamlSubset('name: &anchor value\n'), /aliases are not supported/i);
  assert.throws(() => parseYamlSubset('name: !env TOKEN\n'), /tags and aliases/i);
});

test('JSONC parser strips comments and trailing commas without mutating strings', () => {
  const parsed = parseJsonc(`{
    // comment
    "a": [1, 2,],
    "literal": ",}",
    /* block */ "nested": { "ok": true, },
  }`);
  assert.deepEqual(parsed, { a: [1, 2], literal: ',}', nested: { ok: true } });
});
