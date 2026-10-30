---
fingerprint: 0708409a
slug: the-toolsets-run-preview-omits-a-bound-plugin-te
title: The TOOLSETS run preview omits a bound plugin terminal's tools that the COMMS run is offered
surface: safecell
severity: P2
status: fixed
found: 2026-10-30
lane: authority-census-1030
fix: a6163be13
origin: audit
---

# The TOOLSETS run preview omits a bound plugin terminal's tools that the COMMS run is offered

## Symptom

An agent's room holds a plugin terminal bound to an approved, loaded plugin. A COMMS task for that agent is offered the plugin's tools. GET /api/toolsets, called the way the TOOLSETS (ABILITIES) window calls it, returns a `run` preview that leaves those tools out of `advertised` and `rows`, even though the preview says it is the list that COMMS task is offered. The family rows the window draws are not affected.

## Repro

1. Install a plugin with code that registers one tool (for example `sample_plugin` with `inspect`), and approve it by its digest (`POST /api/plugins/allow`).
2. Bind a plugin terminal in an ASK agent's room to it. `World.heroCaps` returns `{ objectType: 'plugin', pluginId: 'sample_plugin' }`.
3. Open ABILITIES for that agent. It requests `GET /api/toolsets?agent=scout&placed=plugin`: the type only.
4. `run.advertised` has no `plugin__sample_plugin__inspect`.
5. Send the agent a COMMS task. `/api/run` receives the full heroCaps object, and the provider's tool list includes `plugin__sample_plugin__inspect`.
`test/toolsets-preview-equals-run.e2e.test.js` runs both sides against a real approved plugin.

## Evidence

Source: `frontend/app/windows/connectors.js` tsRefresh mapped heroCaps with `.map(c => c.objectType)`. `sidecar/index.js` handleToolsetsList then rebuilt the query as `({ instanceId: 'placed_' + i + '_' + ot, objectType: ot })`, so the pluginId was gone. registerRoomTools skips a plugin object with no pid. handleRun keeps a valid `e.pluginId`, `sidecar/capability/office.js` composeOffice preserves it, and registerRoomTools projects the approved, live plugin. Found by the Codex A5 projection review (A5-PROJ-01, P2), from source only. On 7dfdbdcf5 the extended `test/toolsets-preview-equals-run.e2e.test.js` fails 4 assertions. The bound case's preview is missing `plugin__sample_plugin__inspect` from the wire list the provider received. The unbound case, the refused-id case and the client query check also fail.

## Verdict

Fixed in a6163be13 (authority-census lane). The TOOLSETS client sends a bound terminal as `plugin:<pluginId>`. handleToolsetsList parses that back into `{ objectType: 'plugin', pluginId }` and places every query entry with `placedObjectsFrom`, the mapping /api/run uses for body.placed (moved out of handleRun unchanged). An id that rule refuses stays unbound in the preview, as it does in a run. A bare `placed=plugin` keeps its old result (no plugin tools), and the preview's `assumes` now says such a terminal is unbound. Readout only: what a run is placed with and offered is unchanged. `test/authority-census.test.js` passes with an empty fixture diff. The other ABILITIES-adjacent callers (build.js, stationui.js) still send types only, but they read only the family rows, never `run`.

The review of a6163be13 found one gap in "an id that rule refuses stays unbound". The query was split on every comma and each entry trimmed before the id was read. A query naming `plugin:sample_plugin,x`, an id /api/run refuses, therefore reached the preview as `plugin:sample_plugin` plus a type `x`, and the preview offered sample_plugin's tools. A trailing space was trimmed off an id the run also refuses. No terminal on a station can carry either id. The world model's bindPlugin and placePluginTerminal refuse an id outside /api/run's own pattern (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`), and the doc load keeps a pluginId only trimmed and only when it passes that pattern. So World.heroCaps never yields one and the ABILITIES window never sends one. Only a hand-built GET /api/toolsets reaches this case, which makes it a protocol-robustness guard: the preview must never project a plugin the run refuses, whoever builds the query. The bound-terminal symptom above is the one a Commander reaches. e589cf0fd closes it. The client builds ?placed= in tsPlacedQuery, which encodes each entry before the join. handleToolsetsList reads it with placedQueryEntries, which decodes each entry on its own and hands the id to `placedObjectsFrom` untrimmed. An entry with a malformed escape is skipped. The preview's `assumes` now says whether a terminal was named without its plugin or with an id /api/run refuses. `test/toolsets-preview-equals-run.e2e.test.js` runs the refused id and the comma id through a matching /api/run. On the parent of e589cf0fd it fails 6 assertions: the client query checks (3), and the caveats of the refused and comma cases (3). It passes 288 after. Readout only: handleRun's mapping is unchanged.

77130f067 sends every row of `test/toolsets-preview-equals-run.e2e.test.js` on the client's own wire: tsPlacedQuery from a World.heroCaps-shaped placement, then encoded again as tsRefresh sends it. The bound row now fails if the sidecar stops decoding each entry on its own. A new row places `sample_plugin ` (trailing space) and fails if placedQueryEntries trims the id. The file passes 330 assertions. With d0a84d318's `sidecar/index.js` and `frontend/app/windows/connectors.js` restored it fails 8, the trailing-space row's refused-id caveat among them. Test only: no product code changed.
