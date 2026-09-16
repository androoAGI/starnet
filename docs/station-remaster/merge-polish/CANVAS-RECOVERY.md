# Remaster canvas-loss recovery — 2026-09-16

Reported preview: `http://127.0.0.1:18797/?propSet=projection&skinSet=study`.
The screenshot shows props and agents surviving while the baked station disappears.
Both open preview instances had visible architecture when inspected, so the original
browser/driver trigger was not captured. Do not claim that trigger is proven.

## Confirmed defect and fix

The existing World watchdog sampled only `cache.baseCv`. IndustrialTextures actually
displays an independent high-resolution plate or one of its cached zoom reductions.
Silently clearing one of those leaves the native sentinel opaque, allowing permanent
missing architecture without a context-loss event. A real-canvas regression proves
this mismatch and executes the production watchdog against damaged raster layers.

The watchdog now tracks opaque witnesses for each current remaster plate through the
existing dedicated 1×1 readback canvas, throttled at 250 ms. WeakMap witnesses do not
retain obsolete plates. Transparent/empty geometry does not trigger endless recovery.

Losing a reduction discards only the reduction chain, rebuilt from healthy high detail.
Losing high detail falls back to the intact native station bake, matching the existing
context-loss-event behavior. The next ordinary station rebake restores high detail.
This fallback can reduce close-up detail, but preserves the floor/wall geometry.
Losing the native bake still invokes the existing full station/sky/ground recovery.

## Live verification

The isolated local audit at `:18796` used 188 props, 16 room regions and 68 belt tiles.
Five injected losses all registered as detected and recovered:

| Loss | Recovery observation |
| --- | --- |
| Zoom reductions | 168 ms |
| Zoom reductions, repeated | 163 ms |
| All cached layers, including native station and sky | 6438 ms |
| Zoom reductions after full rebuild | 180 ms |
| High-resolution and zoom layers, native bake intact | 104 ms |

These are observed UI timer intervals, not hardware-independent latency guarantees.
The all-layer case remains a synchronous full rebuild and is materially slower.
The initial implementation rebuilt everything for every fault (6–8 seconds); it was
replaced by the targeted recovery above before delivery.

`Test remaster recovery` in the localhost-only runtime audit reproduces the five cases.
It changes disposable raster buffers, not station contents. Raw measured receipt:
`dev/.scratch-workspace/canvas-recovery-live.json`.

Focused checks: real-canvas projection/depth/recovery regression; existing canvas-loss
contracts (44 assertions); IndustrialTextures contracts (398 assertions); JS syntax
checks and mirrored frontend parity. No physical GPU reset or multi-hour soak is claimed.
