import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export default function setup(): void {
  if (existsSync('scripts/build.mjs')) {
    execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
  }
}
