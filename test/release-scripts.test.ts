import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const checksumScript = fileURLToPath(new URL('../scripts/checksums.mjs', import.meta.url));
const releaseInfoScript = fileURLToPath(new URL('../scripts/release-info.mjs', import.meta.url));

test('release checksums include nested assets and are repeatable', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'keybridge-release-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const files = {
    'dist/index.html': '<!doctype html>',
    'dist/assets/app.js': 'console.log("app");',
    'dist/.vite/manifest.json': '{}',
    'dist/SHA256SUMS': 'stale output',
  };
  for (const [file, content] of Object.entries(files)) {
    const path = join(directory, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  await execute(process.execPath, [checksumScript], { cwd: directory });
  const first = await readFile(join(directory, 'dist/SHA256SUMS'), 'utf8');
  await execute(process.execPath, [checksumScript], { cwd: directory });
  const second = await readFile(join(directory, 'dist/SHA256SUMS'), 'utf8');

  assert.equal(second, first);
  assert.match(first, /  \.vite\/manifest\.json$/m);
  assert.match(first, /  assets\/app\.js$/m);
  assert.match(first, /  index\.html$/m);
  assert.doesNotMatch(first, /  SHA256SUMS$/m);
});

test('release metadata reports transport and envelope versions', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'keybridge-release-info-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'dist', 'assets'), { recursive: true });
  await writeFile(join(directory, 'dist', 'assets', 'app.js'), 'console.log("app");');

  await execute(process.execPath, [releaseInfoScript], {
    cwd: directory,
    env: {
      ...process.env,
      npm_package_version: '2.1.0',
      SOURCE_COMMIT: 'abc123',
    },
  });

  const metadata = JSON.parse(
    await readFile(join(directory, 'dist', 'release.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(metadata.transportVersion, 2);
  assert.equal(metadata.envelopeVersion, 1);
  assert.equal(metadata.sourceCommit, 'abc123');
});
