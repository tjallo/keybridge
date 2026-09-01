import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name !== 'release.json') files.push(path);
  }
}
await walk('dist/assets');
const assets = {};
for (const path of files.sort())
  assets['/' + path.replace(/^dist\//, '')] = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
await writeFile(
  'dist/release.json',
  JSON.stringify(
    {
      version: process.env.npm_package_version,
      sourceCommit: process.env.SOURCE_COMMIT ?? 'development',
      protocolVersion: 1,
      assets,
    },
    null,
    2,
  ),
);
