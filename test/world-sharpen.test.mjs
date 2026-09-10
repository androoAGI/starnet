/* Real headless-WebGL parity for the shipped CRT detail pass. Requires Chromium (SKYNET_CHROME
   overrides discovery). Compiles the ACTUAL world.js shader and compares its readPixels output
   with the ACTUAL CPU sampler. No sidecar, saved station, network service or renderer edits.
   Opaque input matches the composited camera feed; vignette/aberration are disabled to isolate
   detail parity, including the real inverse warp and the off-curve identity path. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { findChrome, connectCDP, evalJS, sleep } from '../scripts/lib/cdp.mjs';

const require = createRequire(import.meta.url);
const R = require('../frontend/app/worldrenderer.js');
const worldSource = readFileSync(new URL('../frontend/app/world.js', import.meta.url), 'utf8');
const initStart = worldSource.indexOf('function initGL(W, H)');
const shaderStart = worldSource.indexOf('const vs = ', initStart);
const shaderEnd = worldSource.indexOf('const mk = ', shaderStart);
assert.ok(initStart >= 0 && shaderStart > initStart && shaderEnd > shaderStart, 'production shader declarations are found');
const shaders = new Function('WorldRenderer', worldSource.slice(shaderStart, shaderEnd) + '\nreturn { vs, fs };')(R);
assert.ok(shaders.fs.includes(R.DETAIL_GLSL), 'test compiles the shipped detail source');

const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(error => error ? reject(error) : resolvePort(port));
  });
});
const stopChild = child => new Promise(done => {
  if (!child || child.exitCode != null) { done(); return; }
  const timer = setTimeout(done, 3000);
  child.once('exit', () => { clearTimeout(timer); done(); });
  try { child.kill('SIGKILL'); } catch { clearTimeout(timer); done(); }
});

function makeFixture(name, width, height, color) {
  const bytes = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) bytes.set([...color(x, y), 255], (y * width + x) * 4);
  return { name, width, height, bytes: Array.from(bytes) };
}
const fixtures = [
  makeFixture('one pixel', 1, 1, () => [37, 81, 163]),
  makeFixture('one row', 9, 1, x => [x * 29, 220 - x * 23, x % 2 ? 76 : 109]),
  makeFixture('one column', 1, 9, (_, y) => [y * 29, 220 - y * 23, y % 2 ? 76 : 109]),
  makeFixture('flat colored surface', 17, 11, () => [67, 91, 113]),
  makeFixture('quiet illumination', 17, 11, (x, y) => [40 + (x + y) % 4, 77 + (x * 2 + y) % 4, 129 + (x + y * 2) % 4]),
  makeFixture('soft colored edges', 17, 11, (x, y) => [
    [0, 20, 70, 130, 145, 160][x % 6], [10, 60, 120, 127, 140][y % 5], [23, 57, 89, 188][(x + y) % 4]
  ]),
  makeFixture('isolated details and borders', 17, 11, (x, y) =>
    x === 0 || y === 0 || x === 16 || y === 10 ? [200, 31, 82]
      : (x + y * 7) % 9 === 0 ? [239, 178, 32] : [48 + x * 3, 65 + y * 4, 110 + x + y])
];
const cases = [];
for (const fixture of fixtures) for (const amount of [0, 0.28, 0.6]) {
  cases.push({ ...fixture, amount, curve: 0, over: 1 });
  if (fixture.width > 1 && fixture.height > 1) cases.push({ ...fixture, amount, curve: 0.04, over: 1.08 });
}

function expectedPixel(fixture, x, y) {
  const { width: w, height: h, curve: k, over, amount } = fixture;
  const nx = ((x + 0.5 - w / 2) / (w / 2)) / over, ny = ((y + 0.5 - h / 2) / (h / 2)) / over;
  const ro = Math.hypot(nx, ny); let rs = ro;
  for (let i = 0; i < 6; i++) {
    const dg = 1 - 3 * k * rs * rs; if (Math.abs(dg) < 1e-9) break;
    rs -= (rs * (1 - k * rs * rs) - ro) / dg;
  }
  const scale = ro > 1e-6 ? rs / ro : 1;
  const sx = (w / 2 + nx * scale * w / 2) | 0, sy = (h / 2 + ny * scale * h / 2) | 0;
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return { packed: 0xff000000, source: -1 };
  return { packed: R.sharpenSample(fixture.packed, sy * w + sx, w, h, amount), source: sy * w + sx };
}

// Runs exclusively in an isolated blank browser page. Production texture filtering, boundary mode,
// shader, uniform range and full-screen triangle are used; readPixels proves actual GPU execution.
function gpuProbe({ shaders: shaderText, cases: inputs }) {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('Headless browser did not provide WebGL');
  const shader = (kind, text) => {
    const result = gl.createShader(kind); gl.shaderSource(result, text); gl.compileShader(result);
    if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(result));
    return result;
  };
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, shaderText.vs));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, shaderText.fs)); gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  for (const axis of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, axis, gl.CLAMP_TO_EDGE);
  for (const mode of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, mode, gl.NEAREST);
  gl.uniform1i(gl.getUniformLocation(program, 'uTex'), 0);
  const uniform = (name, value) => gl.uniform1f(gl.getUniformLocation(program, name), value);
  uniform('uAberr', 0); uniform('uVig', 0);
  const outputs = inputs.map(input => {
    const { width, height, bytes, amount, curve, over } = input;
    canvas.width = width; canvas.height = height; gl.viewport(0, 0, width, height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(bytes));
    uniform('uK', curve); uniform('uOver', over); uniform('uSharp', amount);
    uniform('uInvW', 1 / width); uniform('uInvH', 1 / height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const output = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, output);
    const error = gl.getError(); if (error !== gl.NO_ERROR) throw new Error('WebGL error ' + error);
    return Array.from(output);
  });
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return { outputs, renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
}

let chrome, cdp, profile;
let failed = false;
try {
  const executable = findChrome(), port = await freePort();
  profile = mkdtempSync(join(tmpdir(), 'starnet-sharpen-parity-'));
  chrome = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  cdp = await connectCDP(port);
  const result = await evalJS(cdp, '(' + gpuProbe.toString() + ')(' + JSON.stringify({ shaders, cases }) + ')');
  assert.equal(result.outputs.length, cases.length);
  let maxError = 0, compared = 0, changed = 0;
  for (let i = 0; i < cases.length; i++) {
    const input = cases[i], output = result.outputs[i];
    input.packed = new Uint32Array(Uint8Array.from(input.bytes).buffer);
    assert.equal(output.length, input.bytes.length);
    for (let y = 0; y < input.height; y++) for (let x = 0; x < input.width; x++) {
      const expected = expectedPixel(input, x, y), oi = (y * input.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const want = (expected.packed >>> (channel * 8)) & 255, actual = output[oi + channel];
        const error = Math.abs(want - actual); maxError = Math.max(maxError, error); compared++;
        assert.ok(error <= 1, `${input.name}, strength ${input.amount}, curve ${input.curve}, (${x},${y}) channel ${channel}: CPU ${want}, GPU ${actual}`);
        if (expected.source >= 0) {
          const s = expected.source, sx = s % input.width;
          const neighbors = [s, sx ? s - 1 : s, sx + 1 < input.width ? s + 1 : s,
            s >= input.width ? s - input.width : s, s + input.width < input.width * input.height ? s + input.width : s];
          const values = neighbors.map(n => input.bytes[n * 4 + channel]);
          assert.ok(actual >= Math.min(...values) - 1 && actual <= Math.max(...values) + 1,
            `${input.name}: GPU cannot introduce a halo outside the local channel range`);
          if (actual !== input.bytes[s * 4 + channel]) changed++;
        }
      }
      assert.equal(output[oi + 3], 255, 'composited camera coverage stays opaque');
    }
  }
  assert.ok(changed > 100, 'fixtures exercise actual sharpening rather than only the zero/flat early return');
  console.log(`world-sharpen: ${cases.length} real WebGL cases, ${compared} RGB samples, max CPU/GPU error ${maxError}/255; no neighborhood overshoot. ${result.renderer}`);
} catch (error) {
  failed = true; console.error(error.stack || error);
} finally {
  try { cdp?.ws.close(); } catch {}
  await stopChild(chrome);
  if (profile) {
    const rel = relative(resolve(tmpdir()), resolve(profile));
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && rel.startsWith('starnet-sharpen-parity-'), 'cleanup stays inside its unique test temp directory');
    for (let attempt = 0; attempt < 10; attempt++) {
      try { rmSync(profile, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 9) throw error; await sleep(200); }
    }
  }
}
process.exit(failed ? 1 : 0);
