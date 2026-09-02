import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const files = [];
const assets = {};

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
    } else if (entry.name !== 'release.json') {
      files.push(path);
    }
  }
}

await walk('dist/assets');

for (const path of files.sort()) {
  const asset = `/${path.replace(/^dist\//, '')}`;
  const data = await readFile(path);
  assets[asset] = createHash('sha256').update(data).digest('hex');
}

await writeFile(
  'dist/release.json',
  JSON.stringify(
    {
      version: process.env.npm_package_version,
      sourceCommit: process.env.SOURCE_COMMIT ?? 'development',
      transportVersion: 2,
      envelopeVersion: 1,
      assets,
    },
    null,
    2,
  ),
);
