const { readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { Minimatch, minimatch } = require('minimatch');

// Both upstream consumers use this major-compatible API. Exercise the promoted
// patched major before bundling the client and running the VSIX packager.
if (!new Minimatch('**/*.html', { noext: true }).match('snapshots/a.html') ||
    new Minimatch('**/*.html', { noext: true }).match('snapshots/a.tsx') ||
    !minimatch('dist/extension.cjs', 'dist/**')) throw new Error('minimatch API compatibility check failed');

const root = resolve(__dirname, '..');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const sections = ['# Bundled third-party notices', '', 'Generated from the production dependency lockfile by scripts/prepare.cjs.', ''];
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location || entry.dev || entry.link) continue;
  const directory = join(root, location);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const licenses = readdirSync(directory).filter((name) => /^licen[sc]e(?:\..*)?$/iu.test(name)).sort();
  if (licenses.length === 0) throw new Error(`Missing bundled license for ${manifest.name}`);
  sections.push(`## ${manifest.name}@${manifest.version}`, '', ...licenses.flatMap((name) => [readFileSync(join(directory, name), 'utf8').trim(), '']));
}
writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), sections.join('\n').trimEnd() + '\n');
console.log('Patched minimatch compatibility and bundled dependency notices: passed');
