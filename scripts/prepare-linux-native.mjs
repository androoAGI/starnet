#!/usr/bin/env node
// Transformers v4 (ASR) and Kokoro's v3 (TTS) require different ONNX ABIs.
// Both Linux libraries use SONAME libonnxruntime.so.1, so the loader otherwise
// reuses the first one and rejects the second binding's versioned symbols.
import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function prepareLinuxNative(root, platform = process.platform, arch = process.arch) {
  if (platform !== 'linux') return;
  const patch = (...args) => execFileSync('patchelf', args, { encoding: 'utf8' }).trim();
  patch('--version'); // Fail before renaming anything if the build prerequisite is missing.
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = join(dir, entry.name);
      if (entry.name !== 'onnxruntime-node') { visit(child); continue; }
      const { version } = JSON.parse(readFileSync(join(child, 'package.json'), 'utf8'));
      if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unrecognized ONNX runtime version: ${version}`);
      const bin = join(child, 'bin');
      for (const napi of readdirSync(bin)) {
        const native = join(bin, napi, 'linux', arch);
        const binding = join(native, 'onnxruntime_binding.node');
        if (!existsSync(binding)) continue;
        const original = 'libonnxruntime.so.1';
        const unique = `libstarnet-onnxruntime-${version}.so.1`;
        const library = join(native, unique);
        if (!existsSync(library)) renameSync(join(native, original), library);
        if (patch('--print-soname', library) !== unique) patch('--set-soname', unique, library);
        if (patch('--print-needed', binding).split('\n').includes(original)) {
          patch('--replace-needed', original, unique, binding);
        }
        if (!patch('--print-needed', binding).split('\n').includes(unique)) {
          throw new Error(`ONNX binding does not reference its isolated runtime: ${binding}`);
        }
      }
    }
  }
  visit(resolve(root));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  prepareLinuxNative(process.argv[2] || 'node_modules');
}
