/* node test/desktop-artifact-open.test.js — source contract for saved-file desktop actions.
 *
 * The browser preview remains a real /api/file link. In the packaged desktop, the filename
 * opens only a canonical, existing, non-executable artifact through its OS association; the
 * folder control reveals that exact artifact; copy-path resolves relative workspace paths to
 * their full path. The Rust host owns containment so renderer IPC is not an arbitrary launcher.
 */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const chat = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const rust = fs.readFileSync(path.join(__dirname, '../src-tauri/src/main.rs'), 'utf8');
const decisions = fs.readFileSync(path.join(__dirname, '../docs/DECISIONS.md'), 'utf8');

A.ok(/core\.invoke\('starnet_open_artifact', \{ path: String\(title \|\| ''\), agentId: agentId \|\| 'agent' \}\)/.test(chat),
  'desktop filename click sends artifact identity + owner to the native host');
// (a text file opens that ticket on the station's reading view: readableUrl only appends &view=doc to the minted URL)
A.ok(/core\.invoke\('open_external_url', \{ url: readableUrl\(fileUrl\(title, agentId\), title\) \}\)/.test(chat),
  'the jailed browser preview remains the desktop fallback (a freshly minted file ticket, never a stale href or the master token)');
A.ok(/core\.invoke\('starnet_reveal_path', \{ path: String\(relPath \|\| ''\), agentId: agentId \|\| 'agent' \}\)/.test(chat),
  'folder click reveals the artifact path itself, not the default workspace root');
A.ok(/function absoluteArtifactPath[\s\S]{0,700}workspaceDir\(agentId\)/.test(chat),
  'relative deliverables resolve against the authoritative agent workspace for clipboard use');
A.ok(/copyText\(abs\)/.test(chat) && /copy path/.test(chat),
  'copy-path is explicit and copies the resolved absolute path');

A.ok(/fn starnet_open_artifact[\s\S]{0,500}resolve_artifact_path/.test(rust),
  'native open always passes through the artifact resolver');
A.ok(/fn starnet_reveal_path[\s\S]{0,500}resolve_artifact_path/.test(rust),
  'native reveal always passes through the same artifact resolver');
A.ok(/std::fs::canonicalize\(&candidate\)/.test(rust) && /path_is_within\(&canonical, &root\)/.test(rust),
  'the host canonicalizes symlinks and proves root containment');
A.ok(/artifact_path_hits_hard_floor/.test(rust) && /value == "\.git"/.test(rust) && /value == "\.env"/.test(rust),
  'protected .git/.env paths remain below the native-open floor');
A.ok(/safe_native_artifact_extension[\s\S]{0,900}"md"/.test(rust),
  'Markdown is allowed through the OS default association');
A.ok(!/safe_native_artifact_extension[\s\S]{0,900}"exe"/.test(rust),
  'executable files are not allowlisted for native opening');
A.ok(/starnet_open_artifact,\s*starnet_reveal_path,/.test(rust),
  'both constrained commands are registered with Tauri');

// Host-gesture gate (docs/MISTAKES.md: a renderer IPC call is not a human gesture). Every
// OS launch asks the user through a blocking NATIVE dialog naming the resolved path; the
// answer is one-shot and never cached, and a Cancel is an answer the frontend respects.
A.ok(/fn confirm_host_launch[\s\S]{0,900}blocking_show/.test(rust),
  'the host gesture is a blocking native dialog answered at the host boundary');
A.ok(/fn starnet_open_artifact[\s\S]{0,1500}confirm_host_launch/.test(rust),
  'native open spawns nothing without a host-confirmed gesture');
A.ok(/fn starnet_reveal_path[\s\S]{0,1500}confirm_host_launch/.test(rust),
  'non-Windows reveal retains the host confirmation');
const reveal = fs.readFileSync(path.join(__dirname, '../src-tauri/src/reveal.rs'), 'utf8');
const winBody = rust.slice(rust.indexOf('async fn starnet_reveal_path('), rust.indexOf('#[cfg(test)]', rust.indexOf('async fn starnet_reveal_path(')));
A.ok(/#\[cfg\(windows\)\][\s\S]*?reveal::show_in_explorer\(&artifact\)\?/.test(winBody), 'Windows navigates only after the unchanged artifact resolver');
A.ok(!/explorer\.exe|\/select,/.test(winBody), 'Windows reveal has no command-line quoting ambiguity');
A.ok(/SHOpenFolderAndSelectItems\(item\.0, 0, null\(\), 0\)/.test(reveal), 'files are selected through the native Shell API');
A.ok(!/Command::|FileProtocolHandler/.test(reveal), 'the reveal module cannot launch a file association or shell command');
A.ok(/HOST_GESTURE_DECLINED/.test(rust) && /declined at the host confirmation/.test(rust),
  'a declined gesture returns the marker error the frontend keys off');
A.ok(/declined at the host/.test(chat),
  'the renderer treats a host-dialog Cancel as an answer, not a failure to fall back around');
A.ok(/sole exception[\s\S]{0,500}host-boundary security confirmation[\s\S]{0,500}exact canonical target \+ action/i.test(decisions),
  'the locked no-native-dialog law records the narrow host-security exception instead of contradicting it');

A.report('desktop-artifact-open.test');
