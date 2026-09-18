# Mac boot compatibility repair — September 18, 2026

Source: `14c6a69a8` on `agent/mac-boot-compat-0918`, based on `b737e9cbe`.

## Findings and repair

- The literal negative lookbehind in Chat's table parser prevents older WebKit from parsing the entire Chat module. The replacement scans cells without lookbehind and preserves escaped pipes, empty cells, backslashes and HTML escaping.
- Four frontend requests assumed `AbortSignal.timeout` existed. Widget reads/writes and automation recovery now use `U.timeoutSignal`, which delegates to the native implementation when available and otherwise uses `AbortController` with a deadline. This helper is for bounded non-streaming requests, not model streams.
- The specialty catalog was loaded through the shell's loopback engine origin. Desktop staging now embeds the authoritative `shared/specialties.js` bytes, and a parser-ordered same-origin script tag loads them before the specialty wrapper. Web/dev and website staging keep the same `/shared/specialties.js` path. No duplicated editable catalog or security-policy weakening was introduced.
- Retry exhaustion says `script load retries exhausted`; a script error cannot prove the engine never answered.

## Live evidence

The real isolated sidecar was launched with `node dev/seed.js --keep`, a keyless scratch workspace and port 8996. A test-only proxy at 8997 removed `AbortSignal.timeout` and disallowed cross-origin script loads. These fixtures are under `.dogfood/mac-boot/`; they do not change shipping files.

Before (original affected source from `b737e9cbe`, observed 18:51 UTC):

```json
{"nativeTimeout":"undefined","chat":"object","catalog":"undefined","errors":["script load failed","TypeError: AbortSignal.timeout is not a function"],"boot":"FAILED"}
```

After, same fault conditions (18:52 UTC):

```json
{"nativeTimeout":"undefined","chat":"object","catalog":"object","errors":[],"boot":"passed","pageErrors":"none recorded since page load"}
```

The current Chromium browser supports lookbehind; the before capture does NOT reproduce the original WebKit parse error. That diagnosis is grounded in the customer's exact parser diagnostic, the offending source and WebKit's documented syntax support. The regression rejects reintroduced lookbehind and executes the replacement renderer.

Separately, the real desktop staging script produced the shipping frontend (13,862 files, 284.4 MB). A fixture served those exact staged assets at port 8998, without a working engine and without native `AbortSignal.timeout`. At 18:55 UTC it reported Chat and SharedSpecialties loaded, boot passed, and no page errors. Calling the production `Chat.renderProse` produced cells `a|b` and literal `<img src=x onerror=alert(1)>`, with zero image/script elements created. This proves static boot and escaping; it does not assert that an unavailable engine can perform work.

The unmodified seeded app at port 8996 showed its chat composer and a synced RUNS widget reading 0.

## Automated evidence

Focused checks pass: Mac boot compatibility (legacy/native deadlines, real HTTP cancellation, production widget polling, failure/retry, widget write/refusal, catalog packaging); Chat rendering (58 assertions); boot guard (82 assertions); automation recovery (legacy helper, hydration, explicit resume, read-back and offline state). All changed JavaScript passed `node --check`; `git diff --check` passed.

Full gates passed on the repaired source:

- `npm run test:fast`: **818/818** (`run-fast-tests: OK — 818 step(s) green`).
- `npm run test:http`: **119/119** (`run-test-list: OK — 119 step(s) green`).
- `npm run qa:customer-journeys`: **36/36** (`run-test-list: OK — 36 step(s) green`).
- Website mirror check: 14,530 frontend files plus two embed-only files match.
- Bug-register validation and the focused legacy-helper tests were rerun after final record updates and pass.

Receipts are retained in `.dogfood/mac-boot/{fast,http,journeys}.log`. The authoritative and staged catalogs both hash to `b346c34841d2b2b75eb77dabd2e9c47049a85738a56e001d73eecd4933f41893` (SHA-256).

## Limits and disposition

The affected Mac, its exact OS/WebKit version and the exact installed build are unavailable. The original catalog request's failure cause remains unknown; the desktop boot dependency on that request has been removed. The repair requires a rebuilt signed Mac installer and installed acceptance before claiming installer verification or customer recovery. No customer data, account settings, credentials, release tags, installed app or public downloads were changed.

The source repair is committed in the isolated lane. No trunk merge was performed: `agent/small-screen-0917` owns the serialized merge and post-merge gate during this work. Its trunk integration advanced to `80c9ea54f` after this lane branched. A later integrator must merge current trunk into this lane (never rebase), run the combined fast gate and preserve that lane's reservation and unrelated operational edits. The compatibility record is source-fixed; the original catalog incident stays open for affected-machine engine diagnosis and recovery.
