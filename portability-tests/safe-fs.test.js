'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyFileMap, loadManifest, normalizeFileMap } = require('../lib/portable/safe-fs');

function files(entries) {
  return new Map(Object.entries(entries).map(([name, content]) => [name, { content, mode: 0o644 }]));
}

test('managed writes are atomic, idempotent, update unmodified owned files, and protect local edits', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buildwithcli-output-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  let result = await applyFileMap(root, files({ 'a.txt': 'one\n' }), { target: 'test' });
  assert.equal(result.operations[0].action, 'create');
  result = await applyFileMap(root, files({ 'a.txt': 'one\n' }), { target: 'test' });
  assert.equal(result.operations[0].action, 'unchanged');
  result = await applyFileMap(root, files({ 'a.txt': 'two\n' }), { target: 'test' });
  assert.equal(result.operations[0].action, 'update');
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'two\n');

  await fs.writeFile(path.join(root, 'a.txt'), 'local edit\n');
  await assert.rejects(() => applyFileMap(root, files({ 'a.txt': 'three\n' }), { target: 'test' }), /changed since generation/);
  await applyFileMap(root, files({ 'a.txt': 'three\n' }), { target: 'test', force: true });
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'three\n');
  const manifest = await loadManifest(root);
  assert.equal(manifest.generatedAt, undefined);
});

test('unmanaged files, path traversal, manifest injection, and symlinks are rejected by default', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buildwithcli-safe-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'owned-by-user.txt'), 'user');
  await assert.rejects(() => applyFileMap(root, files({ 'owned-by-user.txt': 'generated' }), {}), /unmanaged/);
  await applyFileMap(root, files({ 'owned-by-user.txt': 'generated' }), { replaceUnmanaged: true });
  assert.throws(() => normalizeFileMap(files({ '../escape': 'bad' })), /Unsafe generated path/);
  assert.throws(() => normalizeFileMap(files({ '.buildwithcli-manifest.json': 'bad' })), /Unsafe generated path/);

  const outside = path.join(root, '..', `outside-${process.pid}.txt`);
  await fs.writeFile(outside, 'outside');
  await fs.symlink(outside, path.join(root, 'link.txt'));
  await assert.rejects(() => applyFileMap(root, files({ 'link.txt': 'bad' }), { replaceUnmanaged: true }), /symlink/);
  await fs.rm(outside, { force: true });
});

test('clean removes only obsolete unmodified managed files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buildwithcli-clean-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await applyFileMap(root, files({ 'a.txt': 'a', 'b.txt': 'b' }), { target: 'test' });
  const result = await applyFileMap(root, files({ 'a.txt': 'a' }), { target: 'test', clean: true });
  assert.ok(result.operations.some((item) => item.action === 'remove' && item.path === 'b.txt'));
  await assert.rejects(() => fs.access(path.join(root, 'b.txt')));
});

test('missing output roots below a symlink ancestor are rejected before directory creation', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'buildwithcli-symlink-root-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const actual = path.join(base, 'actual');
  await fs.mkdir(actual);
  const link = path.join(base, 'linked');
  await fs.symlink(actual, link, process.platform === 'win32' ? 'junction' : 'dir');
  const output = path.join(link, 'nested', 'output');
  await assert.rejects(
    () => applyFileMap(output, files({ 'generated.txt': 'unsafe' }), { target: 'test' }),
    /symlink ancestor|symlink root|symlink component/,
  );
  await assert.rejects(() => fs.access(path.join(actual, 'nested', 'output')));
});
