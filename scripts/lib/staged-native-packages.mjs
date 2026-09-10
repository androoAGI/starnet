// Desktop Linux targets use the bundled glibc Node runtime. npm can install
// Sharp's musl alternative alongside glibc; linuxdeploy scans both and fails
// on the unusable alternative's libc.musl dependency. Keep source deps intact.
export function isUnusedMuslSharp(scope, name, platform) {
  return platform === 'linux' && scope === '@img'
    && /^sharp-(?:libvips-)?linuxmusl-(?:x64|arm64)$/.test(name);
}
