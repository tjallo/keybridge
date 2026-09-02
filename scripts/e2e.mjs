import { spawn } from 'node:child_process';
import { join } from 'node:path';

const projects = ['chromium', 'firefox', 'webkit', 'mobile-chrome', 'mobile-safari'];
const argumentsFromCommand = process.argv.slice(2);
const playwright = join(
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'playwright.cmd' : 'playwright',
);

if (argumentsFromCommand.some((argument) => argument.startsWith('--project'))) {
  await run(argumentsFromCommand);
} else {
  for (const project of projects) {
    await run(['--project', project, ...argumentsFromCommand]);
  }
}

function run(argumentsForPlaywright) {
  return new Promise((resolve, reject) => {
    const child = spawn(playwright, ['test', ...argumentsForPlaywright], {
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal
            ? `Playwright stopped with signal ${signal}`
            : `Playwright exited with code ${code}`,
        ),
      );
    });
  });
}
