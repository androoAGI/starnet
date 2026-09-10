// Desktop Linux targets use the bundled glibc Node runtime. npm can install
// Sharp's musl alternative alongside glibc; linuxdeploy scans both and fails
// on the unusable alternative's libc.musl dependency. Keep source deps intact.
export function isUnusedMuslSharp(scope, name, platform) {
  return platform === 'linux' && scope === '@img'
    && /^sharp-(?:libvips-)?linuxmusl-(?:x64|arm64)$/.test(name);
}

// Local ASR and TTS explicitly select CPU (sidecar/local-voice.js). The optional
// CUDA/TensorRT plugins depend on a separately installed NVIDIA stack, which
// linuxdeploy cannot resolve on the desktop build runner. Keep the CPU/shared
// runtime and bindings, and never prune arbitrary files with similar names.
export function isUnusedDesktopAccelerator(file, platform) {
  return platform === 'linux' && /[/\\]onnxruntime-node[/\\]bin[/\\]napi-v\d+[/\\]linux[/\\](?:x64|arm64)[/\\]libonnxruntime_providers_(?:cuda|tensorrt)\.so$/.test(file);
}
