import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const root = 'dist';
const output = 'SHA256SUMS';

async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesIn(path)));
    else if (entry.isFile() && relative(root, path) !== output) files.push(path);
  }
  return files;
}

const lines = [];
for (const path of (await filesIn(root)).sort()) {
  const file = relative(root, path).split(sep).join('/');
  const data = await readFile(path);
  lines.push(`${createHash('sha256').update(data).digest('hex')}  ${file}`);
}
await writeFile(join(root, output), lines.join('\n') + '\n');
