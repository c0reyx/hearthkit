import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const plugin = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8')).version;
if (plugin !== version) {
  console.error(`package.json is ${version} but plugin.json is ${plugin}. Make them match first.`);
  process.exit(1);
}
run('npm', ['test']);
run('node', ['scripts/build.mjs']);
run('git', ['add', '-f', 'dist']);
try {
  run('git', ['commit', '-m', `release: v${version}\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01Vo11sYWhQUDvQH37Zt5NwK`]);
} catch {
  console.log('dist unchanged; nothing to commit');
}
run('git', ['tag', '-f', `v${version}`]);
console.log(`Tagged v${version}. Push with: git push && git push -f origin v${version}`);
