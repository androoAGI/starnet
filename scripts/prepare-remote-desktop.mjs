// Package the remote uplink alongside the standard Mac desktop shell.
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
if (process.platform === 'darwin') {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  execFileSync(process.execPath, [path.join(root, 'remote/package.mjs')], { cwd: root, stdio: 'inherit' });
  const source = path.join(root, 'work/remote-package/desktop');
  const output = path.join(root, 'src-tauri/remote-deps');
  mkdirSync(path.join(output, 'bin'), { recursive: true });
  copyFileSync(path.join(source, 'bin/gh'), path.join(output, 'bin/gh'));
  copyFileSync(path.join(source, 'starnet-server.tar.gz'), path.join(output, 'starnet-server.tar.gz'));
  copyFileSync(path.join(source, 'BUILD.json'), path.join(output, 'BUILD.json'));
  cpSync(path.join(source, 'licenses'), path.join(output, 'licenses'), { recursive: true });
}
