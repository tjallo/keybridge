import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
const lines = [];
for (const file of (await readdir('dist')).sort()) {
  try {
    const data = await readFile(`dist/${file}`);
    lines.push(`${createHash('sha256').update(data).digest('hex')}  ${file}`);
  } catch {}
}
await writeFile('dist/SHA256SUMS', lines.join('\n') + '\n');
