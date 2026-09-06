import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const capture = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const plugin = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8')).version;
if (plugin !== version) {
  console.error(`package.json is ${version} but plugin.json is ${plugin}. Make them match first.`);
  process.exit(1);
}

const tag = `v${version}`;
try {
  capture('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
  console.error(`Tag ${tag} already exists. Bump the version, or delete the tag with: git tag -d ${tag}`);
  process.exit(1);
} catch {
  // no such tag yet, which is what a release needs
}

run('npm', ['test']);
run('node', ['scripts/build.mjs']);

// The marketplace installs from the tag, so it has to name the tag this release creates.
const marketPath = '.claude-plugin/marketplace.json';
const market = JSON.parse(readFileSync(marketPath, 'utf8'));
market.plugins[0].source.ref = tag;
market.plugins[0].version = version;
writeFileSync(marketPath, `${JSON.stringify(market, null, 2)}\n`, 'utf8');

// dist/ is gitignored during development; the tagged commit is the one place it is committed,
// so an install from the tag gets a built plugin without a build step.
run('git', ['add', '-f', 'dist', marketPath]);
run('git', ['commit', '-m', `release: ${tag}`]);
run('git', ['tag', tag]);
run('git', ['rm', '-r', '--cached', '-q', 'dist']);
run('git', ['commit', '-m', `chore: untrack dist after ${tag}`]);

console.log(`Tagged ${tag}. Push with: git push && git push origin ${tag}`);
