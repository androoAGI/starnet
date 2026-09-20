// Reproducible, private-state-free inputs for the unified desktop remote uplink.
// Only tracked runtime sources enter the server archive; no workspaces, keys or host config.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NODE_VERSION, pickSha, assertNoBundledRuntimeState } from '../scripts/prepare-node.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'work/remote-package');
const ghVersion = '2.98.0';
function hash(file) {
  const fd = fs.openSync(file, 'r'), digest = crypto.createHash('sha256'), chunk = Buffer.allocUnsafe(512 * 1024);
  try { let size; while ((size = fs.readSync(fd, chunk, 0, chunk.length, null))) digest.update(chunk.subarray(0, size)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex');
}
async function download(url, file) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}
async function artifact(base, name, checksums) {
  const file = path.join(out, name), sumsFile = path.join(out, checksums);
  await download(base + '/' + checksums, sumsFile);
  const expected = pickSha(fs.readFileSync(sumsFile, 'utf8'), name);
  if (!fs.existsSync(file) || hash(file) !== expected) await download(base + '/' + name, file);
  if (hash(file) !== expected) { fs.rmSync(file, { force: true }); throw new Error('Checksum mismatch: ' + name); }
  return file;
}
async function nodeBinary(target) {
  const stem = `node-${NODE_VERSION}-${target}`, archive = await artifact(`https://nodejs.org/dist/${NODE_VERSION}`, stem + '.tar.gz', 'SHASUMS256.txt');
  execFileSync('tar', ['-xzf', archive, '-C', out, stem + '/bin/node', stem + '/LICENSE']);
  return { binary: path.join(out, stem, 'bin/node'), license: path.join(out, stem, 'LICENSE') };
}
async function main() {
  if (process.platform !== 'darwin' || !['arm64','x64'].includes(process.arch)) throw new Error('Build the Mac viewer on a supported Mac.');
  assertNoBundledRuntimeState(root); fs.mkdirSync(out, { recursive: true });
  const desktop = path.join(out, 'desktop'); fs.mkdirSync(path.join(desktop, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(desktop, 'licenses'), { recursive: true });
  const localNode = await nodeBinary('darwin-' + process.arch);
  fs.copyFileSync(localNode.binary, path.join(desktop, 'bin/node'));
  fs.copyFileSync(localNode.license, path.join(desktop, 'licenses/Node-LICENSE'));
  const ghStem = `gh_${ghVersion}_macOS_${process.arch === 'x64' ? 'amd64' : 'arm64'}`;
  const ghArchive = await artifact(`https://github.com/cli/cli/releases/download/v${ghVersion}`, ghStem + '.zip', `gh_${ghVersion}_checksums.txt`);
  const ghStage = path.join(out, 'gh-extract'); fs.rmSync(ghStage, { recursive: true, force: true }); fs.mkdirSync(ghStage);
  execFileSync('unzip', ['-q', ghArchive, '-d', ghStage]);
  fs.copyFileSync(path.join(ghStage, ghStem, 'bin/gh'), path.join(desktop, 'bin/gh'));
  fs.copyFileSync(path.join(ghStage, ghStem, 'LICENSE'), path.join(desktop, 'licenses/GitHub-CLI-LICENSE'));
  for (const name of ['node','gh']) fs.chmodSync(path.join(desktop, 'bin', name), 0o755);
  const server = path.join(out, 'server'); fs.rmSync(server, { recursive: true, force: true }); fs.mkdirSync(server);
  // ls-files includes newly staged changes, which makes candidate builds reviewable before committing.
  const files = execFileSync('git', ['ls-files', '-z', '--', 'sidecar', 'shared', 'frontend', 'remote', 'package.json', 'LICENSE', 'NOTICE.md'], { cwd: root }).toString().split('\0').filter(Boolean);
  for (const file of files) {
    const source = path.join(root, file); if (!fs.existsSync(source)) continue;
    if (!fs.lstatSync(source).isFile()) throw new Error('Unexpected non-file in package: ' + file);
    const target = path.join(server, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
  }
  fs.mkdirSync(path.join(server, 'remote/runtimes'), { recursive: true });
  for (const target of ['linux-x64', 'linux-arm64']) {
    const node = await nodeBinary(target);
    const dest = path.join(server, 'remote/runtimes', 'node-' + target);
    fs.copyFileSync(node.binary, dest); fs.chmodSync(dest, 0o755);
    fs.copyFileSync(node.license, dest + '.LICENSE');
  }
  execFileSync('npm', ['ci', '--prefix', path.join(server, 'remote'), '--omit=dev', '--ignore-scripts', '--no-fund', '--no-audit'], { stdio: 'inherit' });
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(server, 'RELEASE'), revision + '\n');
  // The installer verifies packaged binaries/dependencies before sudo installs them.
  const manifest = {};
  function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.isFile()) manifest[path.relative(server, file)] = hash(file); else throw new Error('Unexpected package symlink'); } }
  walk(server); fs.writeFileSync(path.join(server, 'PACKAGE-SHA256.json'), JSON.stringify(manifest));
  execFileSync('tar', ['-czf', path.join(desktop, 'starnet-server.tar.gz'), '-C', server, '.'], { stdio: 'inherit' });
  fs.writeFileSync(path.join(desktop, 'BUILD.json'), JSON.stringify({ revision, node: NODE_VERSION, githubCLI: ghVersion, architecture: process.arch, serverSHA256: hash(path.join(desktop, 'starnet-server.tar.gz')) }, null, 2) + '\n');
  console.log('Verified package inputs ready: ' + desktop);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
