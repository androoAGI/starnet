# Painted prop content integration

`frontend/app/authored-prop-content.js` owns freshly drawn content for the batch03
mission board, trophy case, inbox, calendar and microfiche bodies. It never reads,
edits, recolours or copies old sprite pixels. No simulation, catalog, source-art,
PropSprites, world or HTML integration changes belong to this commit.

Load this script before `propremaster.js`. Its public interface is:

```js
AuthoredPropContent.draw(ctx, id, box, state); // true when recognized/valid
AuthoredPropContent.regions[id];             // frozen exported-PNG unit rectangles
```

`box` is `{x,y,width,height}` for the **fitted new exported image**, in the same
coordinate frame as the drawing context. It is not the catalog footprint or
manifest outer bounds. When PropRemaster trims transparent pixels again, pass its
measured `e.crop` as `box.crop`. For example, with a context already translated to
the prop origin:

```js
AuthoredPropContent.draw(g, id, {...e.box, crop:e.crop}, state);
```

If the context remains in world coordinates, add the prop's world origin to
`box.x/y`. Existing world mirroring and mount lifting stay owned by the caller;
the layer retains their transform. `regions` uses the cropped exporter dimensions
and subtracts the calendar's source crop `(1,54)` exactly once. The coordinates
are tied to `batch03/coordinator/export-checks.json`, not prior artwork.

For correct whole-prop occlusion/fading, compose the body and these strokes into
one reusable plane at full opacity, then apply world alpha to the final blit.
Rendering an alpha-faded body and each overlapping content primitive separately
would accumulate opacity. The layer never resets caller `globalAlpha`, restores
all context state after drawing, and clips cards/cups to the new clear apertures.
The fixture demonstrates the composition order. No per-frame readback is used
by the product module. It draws a bounded maximum of six cups, three quest cards,
three proposal cards and six identified inbox papers regardless of total counts.

## State meanings

| Prop | Input | Rendering |
| --- | --- | --- |
| missionboard | `pins` | Exact OPEN total, up to three physical open-quest forms, exact overflow |
| missionboard | `proposals` | Separate exact proposal count and folded amber forms |
| missionboard | `hot` | Station-gap marker; coexists with the JAM stub |
| missionboard | `jam` | Distinct red-pinned amber warning stub |
| trophycase | `trophies` | Six visible earned cups at most, exact HONOURS total; empty shelves for zero |
| trophycase | `journeyStage` | Four crown cells followed by exact additional-goal count; independent from cups |
| comms_inbox | optional `inboxItems: [{id:string}]` | One paper per unique identified item up to six; exact overflow |
| calwall | none | Weekday labels on an empty schedule form; gentle decorative illumination |
| arc_microfiche | none | Optical alignment reticle and lamp shimmer; no fake document or scan progress |

Every count accepts only finite nonnegative numbers. No titles, earned records,
messages, dates, bookings, success marks or backend progress are generated.
`work` is intentionally unable to manufacture inbox mail or activity claims on
the decorative calendar/reader. The existing inbox prop is cosmetic and has no
mail collection feed in PropSprites; leave its `inboxItems` absent and its trays
remain empty. The optional collection contract is independently tested and does
not connect or infer a new backend source.

Pass `now` in milliseconds and the existing `still` reduced-motion boolean to
every supported prop. Missing time uses zero. `still:true` freezes every temporal
change, including gap illumination, calendar illumination and reader shimmer.

The existing truth path was traced in the source before implementation:

- `world.missionPinCounts` reads visible QuestStore quests, StationQuestStore,
  MaintQuestStore and AutoJobStore, then calls `PropSprites.setMissionPins`.
- `world.trophyCount` projects `Trophies.build` over QuestStore and durable
  QuestStateStore; its earned count feeds `PropSprites.setTrophyCount`.
- JourneyStore's evolution stage feeds `PropSprites.setJourneyStage` separately.
- PropSprites already copies those facts into `o.pins/hot/jam/proposals` and
  `o.trophies/journeyStage`. Pass them through without replacing them with work,
  progress, elapsed time, an asset variant, or a cached previous station's state.

## Verification on 2026-09-14

`node --check` passed for the product module and both test scripts.
`node test/authored-prop-content.test.js`: **104 assertions PASS**.

Live fixture: `http://127.0.0.1:8937/dev/authored-content-fixture.html`, served by
this lane's `node dev/seed.js --keep` app. The fixture uses explicitly labeled
count scenarios and the unchanged exported PNGs. Empty, populated, overflow and
35% opacity modes were clicked and inspected in the Codex browser. All five
source bodies loaded; cards were inside the new panels; cups stayed inside clear
shelf openings; door/frame/glass rails remained visible; calendar entries and
inbox trays remained empty. This is fixture verification, not installed-app or
integrated-world acceptance. No model run was needed or claimed.

The fixture's **Run pixel checks** button reported **15/15 PASS**. Exact browser
readback receipt (FNV-1a RGBA hash, isolated transparent content planes):

| Check | Observed result |
| --- | --- |
| Mission still at 0 / 19000 ms | `266093694 / 266093694` |
| Trophy still at 0 / 19000 ms | `3271127459 / 3271127459` |
| Inbox still at 0 / 19000 ms | `3479510469 / 3479510469` |
| Calendar still at 0 / 19000 ms | `720618034 / 720618034` |
| Reader still at 0 / 19000 ms | `2469272458 / 2469272458` |
| Mission moving at 0 / 7400 ms | `3700244010 / 433514044` |
| Calendar moving at 0 / 7400 ms | `377199445 / 4111000107` |
| Reader moving at 0 / 7400 ms | `2469272458 / 1338323255` |
| Empty / populated mission | `2089680014 / 266093694` |
| Empty / populated trophies | `3586029281 / 3271127459` |
| Activity/time-only inbox | all RGBA bytes zero |
| One identified / duplicate inbox ID | `279251308 / 279251308`, nonempty |
| Zero trophies | all three shelf apertures transparent |
| Caller context | alpha `0.35`, composite `multiply`, transform preserved |
| Grouped 35% content fade | maximum alpha `89/255` |

The browser helper reads pixels only when that explicit QA button is pressed;
the product renderer and fixture frame loop do not read them back.

Integration owner still must register the focused test in `test/fast.list`, wire
the script and draw call, check actual world scale/state transitions, and run the
combined gate. This lane does not modify shared integration files or claim that
the new content is already displayed by the main app.
