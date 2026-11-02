# The agent station builder

Added 2026-09-29. The plan is at https://claude.ai/artifact/CcFcnYcEJraKFMEaXHQiYv.

When the Commander asks, the lead agent can change the floor in these ways:
- **lay out a whole station** (2026-09-30): a ring of rooms round the bridge or a concourse off it, every room furnished
  wall to wall in its style and every corridor planted and lit — beside what stands, or replacing it
- **build** rooms and hallways where the Commander says (the spatial builder, 2026-09-30: "new rooms connected to the
  bridge, and a giant conveyor room we will fill with workflows")
- **design** a room the way the Commander describes it, part by part (vibe design: "a new room, the left side cozy, the
  right side a line that builds and tests code")
- **add** a ready-made assembly line (by default in a new room)
- **add** a furnished room, or every room of a preset
- **swap** the whole station for a preset, backed up like Build mode's Presets
- **restyle** a room's floor or name
- **design anything itself** (2026-10-01): rooms of any shape and size, every piece where it chooses, then **look** at
  the station as it really renders and refine it

The lead works two ways, mixed freely (Andrew 10-01: "the AI model should have the freedom … to make its own decisions
… full customization from the model to place and change it how it wants"):
- **its own design** (REFIT, below): every Refit mode tool on exact tiles. The design decisions are the model's; the only
  rules are the world's own, the same checks a person meets in Refit mode (walls, doorways, what stands on what).
- **shortcuts** (the forms): it fills a menu and StarNet does the placing with the same code Build mode uses. Quick,
  and what a weak model falls back on.

Either way a plan is built on a copy, shown on a card, and lands as one change that one UNDO removes. A weak model's
worst case is a change the Commander didn't want. It can't break the station.

## How it works

The lead has three tools, all DEFERRED (not on the wire until it looks them up, so they cost the per-call payload
nothing): its note says to call `tool_search "station builder"`, which reveals all three, and each result reveals the
rest. `station.map` shows the floor, `station.plan` plans, `station.build` builds.

1. `station.plan`: read-only, no approval. The FORM of the request picks the page's planner:
   - `layout`, `rooms` or `hallways` → `planBuild` (a layout goes on to `planLayout`), after `station.map` (`mapOf`)
   - `line`, `shape` or `purpose` → `StationBuilder.plan`
   - `kit`, `preset` or `zones` → `planRoom`
   - `restyle: { … }` → `planRestyle`

   The page builds the request on a **copy** of the live station and checks it:
   - every new machine and piece of furniture can be walked up to
   - for rooms, no furniture sits on a doorway or the tile just inside it
   - no new routing error appears anywhere
   - every existing dock routes exactly as before

   It returns:
   - a `planId`, which lasts ten minutes and is used once
   - a plain summary. A room's summary names the equipment it brings, because a desk is a computer, and what agents
     gain there in `EquipmentHelp`'s own words: "It brings equipment: a desk (COMPUTE), a rack (FILES). What agents
     gain there: a place to work; read, create and search files."
   - each step's instructions
   - the readiness of any new line (`WorkflowLine.readiness`, the Workflow panel's own blocking list)
2. `station.build`: write access, the approval card, and a **taint lock** (step instructions persist and later runs
   obey them). It applies exactly that plan inside one `transact`: one undo slot, all or nothing. It refuses:
   - if the floor changed since the plan
   - if Build mode is open, because the Commander owns the floor then
   - if the result would differ from the plan by a single tile, in which case it rolls itself back

   The approval card shows the plan's own summary and each step's instructions, including the steps of a kit's or a
   preset's own line. The sidecar reads them from the memo the plan tool filled; it never uses the model's words.
   The card also **draws** the plan (`planpreview.js`, the station preset cards' recipe): the station's rooms dimmed, the
   room the plan adds or changes lit, each zone outlined and numbered, and what will stand there. The page draws it
   from its own parked plan (`StationCommands.previewFor`).
   After a build the camera shows the new room (the whole station after a preset), with the note "Built by NOVA: … ·
   open BUILD and press UNDO to remove it".

   In Full Access the build runs without the card, like every other write tool: the consent broker bypasses every
   prompt in that posture.

## Station layouts: a whole station, composed

Added 2026-09-30. Andrew saw two stations laid out by hand in the real renderer ("this is so much better, can the agent
reliably do this?"); this is those two layouts as patterns StarNet computes. `station.plan` with
`{ layout: { pattern, rooms: [ { name, style, size, lines } ] }, replace }`:

- `diamond` (was `ring`; `ring` still means it): every room on an EVEN GRID round the hub, the bridge's size (18 × 11), a
  hallway apart, filled in diamond order — the four sides, then the four corners and the far sides, then the next ring
  out — each room paired with the one opposite it, so the station keeps its diamond at any size (up to 16 rooms a
  plan). At the centre, when the space round the hub is clear, a corridor loop with a hallway in from each side. Big
  rooms take the east and west wings (then north and south), anchored on the grid's inner edge. Each room is joined
  by a straight hallway to what faces it toward the hub. A layout sent again with only NEW rooms puts them in the next
  free places of the same grid, so a station grown two rooms at a time ends exactly where one built all at once does
  (tested). Added after Andrew's test: "good at designing the rooms, terrible at judging where to place them… keep
  the diamond shape even with the new rooms".
- `concourse`: a 4-wide corridor from one side of the hub (`side`, else the first free one), rooms on short halls down
  both sides, a big room flush on its far end. Up to eight rooms. It GROWS IN PLACE (`concourseOf` reads it back from
  the floor): a concourse asked again, a plain room, a kit or a line's room with no spot named takes its next place —
  across from the room with no twin yet, else a new pair (left side first), the spine lengthened by a planted stretch
  when it runs out; a big room (larger than `large`; a conveyor hall is giant unless sized) takes the far end. It never
  builds a second concourse.
- A room's `style` is one of 15 whole-room styles (`RoomStyles.ROOMS`: lounge, cozy, games, library, quarters,
  garden, cafe, desks, meeting, lab, workshop, comms, storage, gym, works), also by a word ("arcade", "conveyor
  hall") or, with no style, by the room's name. A room with `lines` is a conveyor hall (works); its lines are
  **shelved** (see "Lines that share a room" below).
- `replace: true` lays the station out again around its main room: the page's own `replaceLayout` clears everything
  else (every agent that owned a desk gets one), then the layout is built piece by piece (a lamp on its table). The
  page backs the old layout up to Build mode's slot first, so RESTORE PREVIOUS brings it back. The crew is seated
  **accordingly**: the desks `replaceLayout` gave agents whose rooms are gone (the main room's first free spots), and
  every specialist's desk when the main room holds a pile of them (more than 3, as summons leave), move to tidy rows in
  the new rooms, two to a room, the rooms where desks belong first (office, lab, library…). The lead keeps its desk on
  the bridge; a bridge with a desk or two stays as it was. The card says where they go ("8 desks move to OFFICE, LAB,
  LIBRARY, CONVEYOR HALL").
- Beside what stands, a ring needs clear space all round its room; the refusal says to use `replace: true` or a
  concourse from a free side.

**Designing a station** (`frontend/app/stationdesign.js`, added 2026-11-01): the art direction the planner works from.

- `layout.theme` dresses the whole station in one palette: noir, observatory, biolab, neon, timber, foundry, solarpunk,
  flagship or brutalist, by id or by a word in the Commander's own phrase ("a moody cyberpunk club" is neon). Each room
  takes its family's floor and walls (living, work, heavy, play, green); corridors, hull, the hub and the field under each room's hero
  follow. The palettes use the jewel-tone swatches added to `FLOOR_STYLES` (royal, sapphire, plum, magenta, jade, oxblood,
  copper, honey), because the older swatches wash out to one brown under the warm lamp pass. A theme changes materials only, never a piece, so it never changes what a room can do. Which floor goes with
  which room is the palette's: a room's own style still chooses its furniture.
- `layout.pattern` also takes five plans beyond the diamond and the concourse: `axis` (a corridor out of both ends of the main
  room), `enfilade` (rooms opening one into the next, no corridor, doubling back after three), `colony` (grown, rooms of
  different sizes budding off one another, the same names growing the same colony), `campus` (pods round small plazas on long
  bridges, up to 12 rooms) `pinwheel` (four off-centre corridors each carrying rooms to one side, up to 12), `court` (rooms opening onto one big square, up to 9) and `terrace` (rooms stepping away on two diagonals). A `replace` with no pattern takes its palette's plan, or with no palette one chosen from what the rooms are for; the station remembers its plan and palette (`meta.stationPlan`), so rooms added later with no place asked follow them. A replace shifts main-room pieces clear of new doors and says so on the card; a retheme keeps painted floors. All run the same
  checks. A themed layout with `replace` and no pattern takes its palette's own plan; with no theme, or beside what stands, it is
  still the diamond. Adding a room later still uses the grid or a free side: these plans have no grow-in-place of their own yet.
- `layout.from` starts from a prebuild (a `StationTemplates` preset id or name): its rooms and its lines with their
  instructions, then any `rooms` the design adds. A room named the same as a prebuild room replaces it.
- A size on a diamond room is honoured: larger than the grid's 18 × 11 anchors it on the inner edge, smaller stands in
  its cell. That is how a station gets a heart and small rooms round it.
- `{ retheme: a palette }` (an edit) re-dresses what stands through `planRefit`: floors, walls and hull. No piece moves.
- `station.map { guide: true }` gives the design principles, the palettes and the prebuilds.
- **The design review** (`StationDesign.critique`; `StationBuilder.review` for a floor, `reviewPlan` for a plan on a
  copy) scores coverage, light, groups, stranded pieces and hierarchy. `design: { score, grade, station, rooms }` comes
  with every room, build and edit plan, with `station.map` and with the build receipt. It is advice and refuses nothing.
  A rough grade adds one look and one refit to the receipt's `next`.

**Dressing a room** (`dressRoom`, also for a plain build's room with `style`): its floor and walls, then, for every
style with a recipe in `StationDesign.RECIPES`, `compose`: door lanes, a back wall on the north with a framed centre, the
hero group, required equipment, groups on the largest clear floor (each once unless it repeats; a twin only where it
pairs; wall groups only on a wall), floor lights, then a field of the accent floor under the hero. `openPockets` takes back whatever seals off
floor, and `must` equipment is put back after any prune. A style with no recipe (`works`) keeps the older dressing: the
feature wall lined with the style's signature pieces; the centrepiece cluster, facing it, rug first then furniture then
what stands on tables; plants in the corners; accents on the side walls. Every doorway keeps a lane three tiles deep,
nothing lands on a belt, and a piece nobody could walk up to is taken back out. **Dressing a corridor** (`dressHall`): planters, floor lights and benches every fourth tile along its edge rows, clear of the
doorways on that row, always two rows clear to walk.

## The spatial builder: rooms where the Commander says

Added 2026-09-30, after a live test where the lead could not place a room, use a hallway, or build an empty one. The
model still never sends a tile. It **looks**, then says where things go in words.

`station.map` (read-only) is what the lead sees:
- every room: its name, position and size in tiles, its type, which one is the main room (the Commander may say
  "bridge", "hub" or "main room")
- what each is joined to, and how: "HOME (through a hallway)", "ANNEX (open to it)"
- its lines, how many machines and pieces of furniture it holds, how much of its floor is clear
- `roomForANewRoom`: which sizes fit on each of its four sides. Every size it lists really plans there (tested).
- the floor drawn in characters, one letter per room and `+` for a hallway; north is the top

`station.plan_build` takes `rooms` (1 to 6) and/or `hallways`. One plan, one approval card, one undo.

| Field of a room | Accepts |
| --- | --- |
| `name` | A new room's name. Left out, a room with a whole-room `style` is named for it (LOUNGE, OFFICE, CONVEYOR HALL), else for what fills it first, else `ROOM n`. |
| `size` | `small` (12 × 8), `medium` (18 × 11, an empty room's default), `large` (24 × 14), `giant` (36 × 20), or `{ w: 6-44, h: 5-26 }`. Left out, a room with zones or lines is sized for them and grows until they fit. |
| `beside` | The room it joins, by name. "bridge", "main" or "hub" mean the main room. A room earlier in the same list works. Left out (and no `side`), the room takes the **next free place of the station's grid**, the same place a diamond layout would give it, at its own size (a small room centred on its cell's inner edge, a big one on a wing); so rooms asked one at a time grow the same diamond as one laid out at once (tested), and its hallway is a station corridor like a layout's (the corridor deck, planters and floor lights), never a bare run of floor. Only when the grid has no place left does StarNet take the spot that keeps the station most compact. |
| `side` | north, south, east or west of that room (also left, right, top, below). Left out, the most compact side. |
| `hallway` | `true` (the default: a hallway 3 tiles long, as wide as the presets' own), `false` (the rooms touch and open onto each other), or a length from 2 to 8. |
| `align` | center, start or end along the shared wall. Left out, centred, sliding along the wall to find clear floor. |
| `into` | Instead of all of the above: an existing room's name, to fill it where it stands. |
| `type`, `floorStyle`, `floorMat` | As in `station.plan_room`. FOUNDRY suits a room of conveyor lines. |
| `zones` | Parts of the room, as in vibe design below. |
| `lines` | Instead of zones: 1 to 6 workflow lines laid anywhere in the room, each `{ line | purpose | shape, name, staff, dailyCap, tries }`. They are shelved (below), so they read as separate lines. |

A room with neither zones nor lines is built **empty**, for the Commander to fill later ("put three lines in the
conveyor hall" is then `{ into: "Conveyor Hall", lines: [...] }`).

`hallways: [{ from, to }]` lays a hallway between two rooms (straight when they face each other across a gap; round ONE corner, out of one
room's side wall and into the other's end wall, when they stand diagonally apart: `hallL`), dressed as a station
corridor, including rooms
added earlier in the same plan.

What placement guarantees, beyond every plan's checks:
- A hallway's doorway never opens onto furniture: it slides along the wall to clear floor. Nothing that hangs on a north
  wall is left hanging over an opening.
- A new room or hallway never stands against a room it was not asked to join. Rooms that touch open onto each other, so
  that would open a wall nobody asked for.
- Every new room can be walked into from the main room.
- A refusal says why and what does fit: "There is no room for a 18 × 11 room north of HOME with a hallway: a hallway is
  already there. That size fits east, west of HOME." When the named room is full, it names the rooms that have space.

`station.plan_line` and `station.plan_room` place their new rooms the same way, and take `beside`, `side` and `hallway`
(and `size`, for a room of zones).

**Lines that share a room** (the polish pass, 2026-09-30, after Andrew asked for "a bunch of useful workflow conveyor
systems" and saw them come out as one interleaved clump in the middle of the hall, their stat plates over each other's
machines). A room's lines are SHELVED when it takes several, already holds some, or is a hall (two grid rooms' floor or
more): each line goes at the first clear spot in reading order, a tile in from the walls, off the doorways' landings,
with `AISLE` (3) clear tiles round every line already there. A hall therefore fills in tidy rows with walkways between,
the same whether its lines come in one plan or one at a time (`fillRoom` for designed rooms and `plan()`'s stamp scan for
shelf lines both do it). One line in a room its own size stays centred. Failing both, a line goes wherever it fits.
With no `where`, `station.plan_line` puts a line into the station's conveyor hall (a works room, or one named for lines)
when it has room, before it makes the line a room of its own on the grid. Recruits' desks stand together: one row
centred on a wall (the top, then the bottom), split only when no row takes them all.

**A room of zones is never half bare.** A room made only of styled parts (no whole-room style, no line zone: a line's
half keeps its floor) gets plants in its free corners, and the card says so ("two tall plants and two plants in the
corners").

## REFIT: the Commander's own tools

Added 2026-09-30 ("make it immensely more flexible, there should be no limits, it should be able to ambitiously use the
refit mode itself"). `station.plan { refit: [ edits ] }` gives the lead every tool of Refit mode as an edit on exact
WORLD tiles (x east, y south; a piece's x, y is its top-left), up to 1500 edits a plan (400 until 10-01), applied IN ORDER on a copy by
the very world-model call Refit mode makes for that tool (`refitOne`), so each passes or fails on Refit mode's own
checks (`checkRects`, `checkProp` with the mount rules, `beltPlaceable`, `checkBlueprint`). The first edit that fails
refuses the whole plan, naming it ("Edit 6 (place): overlaps a prop"). station.build replays the edits exactly
(`refitAll` inside the one `transact`), so one UNDO takes all of it back. The card lists every edit in words (a brief
quoted), and warns when the floor would have a routing problem or a room nobody can walk into.

| Edits | World-model call |
| --- | --- |
| `room` { name, kind, x, y, w, h } or rects (L, U) · `hall` { x, y, w, h } | `addRoom`, `placeHallway` (+ corridor deck) |
| `resize` { room, x, y, w, h } · `move` { room, x, y } · `delete` { room } · `rename` · `type` { kind } | `resizeRoom` (new: grown or shrunk where it stands, never cutting what is on it), `moveRoom`, `removeRoom`, `renameRoom`, `setRoomKind` (new) |
| `floor` / `walls` / `hull` { room, style, mat } · `paint` { room, style, tiles } · `style` { room, style } | `setDeck`, `setWalls`, `setHull`, `paintTiles`, a room style's deck + walls + `dressRoom` |
| `place` { t, x, y, r, m, as } (any piece, a player-made prop, or a machine) · `move` / `rotate` / `mirror` / `delete` { prop } | `addProp` (footprint from `footprintAt(t, r)`), `moveProp`, `faceProp`, `mirrorProp`, `removeProp` |
| `agent` · `door` · `role` · `brief` · `label` · `cap` · `tries` · `routes` { prop, … } | `assignPropAgent`, `setDoorState`, `setPropRole`, `setPropBrief`, `setPropLabel`, `setPropLimits`, `configureJunction` |
| `belt` { from, to } · `unbelt` { tiles } · `connect` { from, to } | `placeBeltRun`, `removeBelts`, `connectBelt` |
| `stamp` { line, x, y } · `edit` { prop, edit, args } | `stampBlueprint`; the Workflow panel's own `LineEdit.run` (insertStep, appendStep, addBranch, addLoop, addSorter, addRoute, removeStep, moveStep, tidy, addOutbox …) |

A piece is named by its id (from `station.map { room }`), a name given earlier with `as`, or a tile `[x, y]`; a room
by its name or an `as`. `station.map { room }` details a room tile by tile (every piece with its id, type, place,
size, agent, role, label and brief; its belts; its doorways; the room drawn: `.` floor, `#` a piece, `_` a walk-over
piece, `A` a seat, `M` a machine, `=` a belt, `D` a doorway). `station.map { catalog: true }` lists every piece (type,
size, mount, turns, flips, yours), room types, floor styles and materials, wall and hull materials, room styles, bay
roles, lines and line edits.

**The lead designs (2026-10-01).** The planner's instructions open with the design handed to the lead ("You are the
station's designer: the Commander's words are the brief, and the design is yours to decide"), REFIT first and the forms
after it as SHORTCUTS. Until then they opened with "You never send a position" and listed REFIT last, for "anything
the forms above do not say", so a capable model reached for the forms. A long refit's card names its first 25 edits and
then every edit that removes, moves, resizes or briefs, up to 60. Past that it counts them by kind ("… and 7 more edits
that change what stands (7 moves)"), and the preview shows them all.

**LOOK.** `station.map { look: a room }` (or `true` for the whole station) hands the model the station as it really
renders: the stage's own scene pass (`World.renderStillOfTiles`, a crop of `World.renderStill`, one tile round the room
and the wall faces above it), WebP (else JPEG), shrunk until it fits one page answer (the sidecar's 256 KB ack). It
rides back as a tool image (loop.js SCREENSHOTS AS PIXELS, on unless `SKYNET_TOOL_IMAGES=0`; every provider adapter
carries image parts), with a note giving the tiles it shows and the pixels a tile. A model that can't see is pointed
to `station.map { room }`. Proven: the e2e's stand-in model asks for a look and the next model request carries a
1100 × 825 picture of the room (223 colours, not a blank frame). With a real model (GPT 6.1 Sol), "design me a cozy
reading nook off the lounge, your way … then take a look and keep refining" became a 12 × 8 room with a narrower entrance
alcove and every piece placed by hand. It looked, saw the back-wall bookshelves sat left of centre and the lounge TV
crowded the new doorway, refitted both, and looked again.

**Chairs (Andrew 10-02: two chairs under every desk, side chairs turned backwards).** A desk (any workstation) draws
its own chair the moment an agent works it, so its seat row stays clear: a refit that puts a piece there is refused,
staffing a desk takes away a chair already standing on its seat, the office styles no longer set chairs at desks (or lamps
on the bare floor between them), and `station.map { room }` lists `issues` (a piece on a seat, a seat turned away from its
table). A seat takes `toward: <table>` and the builder works out its facing. A seat placed, moved or turned by hand right
beside a table or desk without `toward` is turned to face it once every edit is down, and the summary says so. The
meeting styles' south chairs faced away, and a room dressed with its door on the north wall mirrored its sets without
turning their pieces. Both are fixed, and a test checks every styled seat against its table.

**Left/right pieces.** A recliner is drawn facing west and recliner_r east. The same goes for the telescope, camera
rig, weapon rack, heavy bag and bench press. The catalog labels ("recliner ‹ left") read as "the one for the left side",
and the lounge, cozy and library styles had both recliners backwards. Now:
- The styles pick the twin by the way it should face.
- The catalog and the room detail say `faces: west | east`.
- `toward`, or an `r` of west or east, picks the right twin.
- `rotate` flips one.
- The dresser turns a twin set against a side wall to face the room.
- `issues` flags any seat or twin facing straight into a wall.

`toward` on a piece that cannot turn (a stool) places it as drawn and says so, rather than refusing the plan.

**The 10-02 sweep** (two independent reviews plus a live render of every style):
- **Seats:** the dresser and named-piece adds keep every desk's seat row clear, including desks they place themselves. The
  desks and comms styles used to trip the builder's own seat refusal in a narrow room.
- **Seat side:** the seat row follows world.js exactly (a turned remaster desk seats on its front; `m` swaps west and
  east).
- **Mirrored rooms:** a room dressed with its door north mirrors only its chairs, never desks. A set holding the couch,
  drawn from behind, is never mirrored.
- **Re-lay groups:** rooms joined open plan move as one, so a line or a bench across the join stays whole. Rooms open to
  the main room stay with it.
- **Re-lay sizes:** the grid cell takes the station's own room size (up to 30 × 18), so six small or six large rooms
  re-lay where they used to be refused.
- **Re-lay checks:** it refuses if a line would gain a warning, a hallway would lead nowhere, or a piece would stand
  outside every room.
- **Wording:** the re-lay card counts the pieces leaving with the old hallways. The refusals name real rooms, not
  placeholders.

**Limits raised at the same time:** recruits 3 → 12 a plan (still only when the Commander asks), named pieces 16 → 120
(40 of one kind), rooms in a rooms plan 6 → 24, lines in a room 6 → 16, a diamond 16 → 40 rooms, a concourse 8 → 24,
rooms removed at once 8 → 60, a hallway 40 → 160 tiles (200 round a corner), a designed room 44 × 26 → 96 × 60. The
bound left is the world model's own: a station spans at most 240 tiles.

## Conveyor lines: set up, tested, started

Added 2026-10-01 (Andrew: "and what about for conveyor systems, and then also setting up the conveyor systems?"). The
lead could already build any line (machines, belts, branches, loops, sorters, staff, roles, instructions). It now sets one
up, tests it and decides what starts it, as a person does in the Workflow panel.

**Set up (REFIT edits)**, each the Workflow panel's own setter:

| Edit | Sets | World-model call |
| --- | --- | --- |
| `hands` { prop: a bay, text } | what that step hands on | `setPropHands` |
| `budget` { prop: any machine on the line, stages, perJob, perDay } | the line's whole budget (`cap` still sets the day) | `setPropLimits` on the line's INBOX |
| `loop` { prop, passes, until, done, escalate } | max passes; until approved / revise (the reviewer's VERDICT) or code / research / general; the exit and escalation sides | `configureJunction` |
| `wait` { prop: a joiner, minutes } | how long a JOINER waits for every branch | `configureJunction` |
| `swap` { prop: a joiner or merger } | JOINER (the splitter copies to each, waits for all) ↔ MERGER (the branches take turns) | `swapJoinerMerger` |
| `routes` { prop: a filter, routes, def } | what kind of work leaves which side | `configureJunction` |
| `folder` { prop, project } | the working folder: only a trusted project | `setPropProject` on every INBOX of the line |
| `bind` { prop: a connector portal or plugin terminal, connector / plugin } | which service's tools its room's agents get | `bindConnector`, `bindPlugin` |

A junction edit changes only what it names (`jcfg` keeps the rest). Before 10-01, `routes` or `tries` replaced the
junction's whole config, so setting a loop's tries wiped its wait or escalation lane. `folder` and `bind` are resolved
when the plan is made, against what the page reads from the sidecar (`/api/projects` blessed roots, `/api/connectors`,
the plugins that are on), and the resolved root or id rides in the plan (`spec.res`), so the build replays exactly what
the card showed. The model never supplies a raw path or service id. `station.map { room }` reads every one of these
settings back per piece.

**Test: `station.test_line { line, job, room? }`.** One real job down the line through `runSampleJob`, the core of
`POST /api/routing/sample`. That route is the Workflow panel's TEST and WORKFLOWS' SEND A JOB, and both now call the
core. So it has the same one-per-station lock, the same refusals, and the same job record in the OUTBOX.
- It answers each step in the order it ran (role, agent, how it ended, cost), whether the job reached the OUTBOX, and
  says plainly when a review loop ran out of passes without an approval.
- What the line delivered comes back fenced as untrusted data.
- It asks first: it runs the line's agents and spends what they spend. A line nobody works is refused before anything is
  sent.

**Start: `station.start_line`.** Each start goes through the core the panel's form posts to. It asks first: from then on
the line runs unattended, within its budget.

| Call | Creates |
| --- | --- |
| `{ line, schedule, tz?, job }` | a `runsLine` routine fired at the line's entry step (`createCronJobFromSpec` + arm on create). The routine's own tripwire scans the job's words. |
| `{ line, folder, job }` | a folder trigger (the folder jail + baseline). |
| `{ line, webhook: true, job }` | a webhook trigger. Its key is minted, hashed and dropped: the lead never sees one, and the Commander takes a key from the line's Workflow panel (NEW KEY). |
| `{ line, off: a trigger id }` | turns a trigger off. A schedule is a routine, and `routine.manage` pauses it. |

## Making new props (StarNet credits)

Added 2026-10-01 ("if the user has StarNet credits… the agent should be able to use that and create props on its own
using our system"). `station.make_prop { describe, sideView }` is a fourth deferred builder tool (revealed with the
rest by `tool_search "station builder"`). It runs the station's OWN prop maker, the one REFIT's MAKE A PROP uses
(`deps.userProps`: `start(noun)` → StarNet's prop pipeline → the job lands in `WORKSPACES/.userprops`), so it needs
the station linked to StarNet credits and refuses with the link/top-up door otherwise ("Making props uses StarNet
credits. Link this station under SETTINGS → PROVIDERS first."). It costs StarNet credits, so it is consent-gated and
taint-locked: the approval card says "Make a new prop with your StarNet credits: "a hot dog stand" (about $0.35, and
about $0.30 more for its side view)". It waits (up to six minutes, its own `timeoutMs`) for the prop to land, asks the
page to load the MADE BY YOU library (`station.props_reload` → `UserProps.load()`), and answers the prop's name, id,
footprint and real cost, with how to place it: `station.plan { add: { room, pieces: ["hot dog stand"] } }` or a REFIT
`{ op: "place", t: "user_…" }`. `sideView: true` then draws its side view (a second paid step) so it turns; a round
prop is never charged for one. A failed drawing says why and what the tries spent; one still drawing when the wait
ends says it will appear in MADE BY YOU. Props already made show as `yours` in `station.map { catalog: true }` and
cost nothing to place again.

## Editing what stands

Added 2026-09-30 ("it should be able to build anything the user wants"). `station.plan` with one of these goes to the
page's `station.plan_edit` (`StationBuilder.planEdit`); like every plan it is built on a copy, checked, and built in
ONE undo:

| Form | What it does |
| --- | --- |
| `{ remove: room \| [rooms] }` | Takes up to 8 rooms out with everything on them: furniture, and any workflow line (named on the card). A hallway that joined them and now joins nothing goes too (one that never touched them stays). An agent whose only seat stood there gets a desk in a tidy row elsewhere (`desksFor`). The main room never goes, and a removal that would cut another room off from the bridge is refused naming it ("That would cut LAB, GYM off from HOME…"). |
| `{ refurnish: { room, style, name } }` | Clears the room's furniture and furnishes it in another whole-room style, floor and walls too (`dressRoom`). Its lines and agents' seats stay where they are. A room still named for what it was (LOUNGE, ROOM 3) takes the new style's name; a `name` given wins. |
| `{ clear: room }` | Removes the room's furniture. Lines, agents' seats and fixtures stay. |
| `{ add: { room, pieces } }` | Places NAMED pieces: `["a tv", "three plants", { "piece": "sofa", "count": 2 }]`, up to 16 a plan. Any piece of the page's catalog by its id, label, card name or a word for it ("sofa", "fridge", "fish tank"), and any prop the Commander made, by the name its maker gave it. A wall piece hangs on the back wall, a table piece (a lava lamp) stands on a table (or the refusal says to add one), a rug lies on the open floor, everything else stands against a wall first (the back, then the sides, then the front) and then the open floor; never on a belt or a doorway's lane, and never where it or anything already there could not be walked up to, or where a room would be cut off. Workflow machines are not pieces (lines bring them). |
| `{ remove: { room, pieces } }` | Takes named pieces out ("the couch", "all plants"); what stood on a table that goes, goes with it. An agent's seat is not taken this way (seat the agent elsewhere). |
| `{ remove: { line, room? } }` | Takes one workflow line out, its machines and belts, by its name ("build and test" finds BUILD + TEST). Every other line stays exactly. |
| `{ seat: { agent, room } }` | Moves an agent's desk (or gives one) into the room, in a tidy spot against its wall. |
| `{ move: { room, beside, side } }` | Moves a room with everything in it (furniture, lines, seats ride along, `WorldModel.moveRoom`): its old hallways that would join nothing go, a new corridor, planted and lit, joins it where it lands. The main room stays; a move that would strand a room is refused naming it. |
| `{ undo: true }` | "No, undo that": takes back the lead's own last build (the page keeps a record of them per station, ten deep), only while the station is exactly as that build left it, so it never takes back the Commander's own edit; one step, as Build mode's UNDO, checked to land exactly on the station before the build. After a page reload the one-step history is gone, and the refusal says which edit takes it back instead. |
| `{ staff: { line, steps } }` | Restaffs an existing line where it stands: `[{ step, agent, instructions }]` by run order, `agent: "nobody"` clears a step. Recruiting is not done here. The card lists every step's instructions. |

The card names every piece of equipment that goes ("Equipment that goes: a dish (WEB), a studio (IMAGES)"), so
nobody loses a capability unawares. Rooms do not move or resize: the refusal says to remove one and build it again
where it should be. Real-model proof (GPT 6.1 Sol, 09-30): "turn the garden into a games room" refurnished it; "get
rid of the office and add a cozy den" refurnished the office in place (keeping the diamond); "remove the games room
completely" removed it and its hallway.

**Rooms by any name.** `RoomStyles.resolveRoom` maps the rooms people ask for to the nearest of the fifteen styles:
medbay / infirmary / sick bay → lab, server room / control room / mission control → comms, cinema / theater →
lounge, art or music studio → cozy, classroom / war room → meeting, dojo → gym, spa / hydroponics → garden, armory /
hangar / vault → storage, engine room / reactor → workshop, archive → library, coworking → office, pub / diner /
break room → cafe, and more. A style named anywhere in the words wins ("crew lounge" is a lounge); otherwise the head
word, read from the end ("mission control"). A word with no near style ("bathroom") is refused with the styles.

**The origin bug.** Found while building this. The routing plan counts tiles from the station's top-left corner, and a
room added north or west of everything moves that corner. `floorFacts` compared those local tiles, so on any station
with a working line every such room was refused as "that would change how an existing line routes". It went unseen
because the old placement only ever grew east and south. Routing facts are now compared in world tiles.

## Vibe design: a room described part by part

`station.plan_room` with `zones`: a list of 1 to 4 parts of the room, each `{ area, style }` or
`{ area, line | purpose | shape, name, staff, dailyCap, tries }`.

- `area`: left, right, back, front, back-left, back-right, front-left, front-right, or whole (on a 2 × 2 grid; top is
  the back, bottom the front). Areas may not overlap.
- `style`: one of 14 in `frontend/app/roomstyles.js` (cozy, lounge, library, desks, meeting, cafe, games, garden,
  quarters, storage, gym, lab, comms, workshop), also by name or word ("comfy"). Each is a few hand-arranged sets of the
  presets' own furniture, largest first. StarNet seats the largest set that fits, against the room's outer walls, as
  arranged or mirrored, off every doorway's landing, with every piece reachable. The card lists the pieces really
  placed.
- A line zone holds one line, laid out **inside the zone** by the Workflow panel's own layout engine
  (`LineLayout.layout`, written by `applyLineLayout`):
  - `line`: a shelf line, by id or name
  - `purpose`: the Commander's words; StarNet picks the line, as `station.plan_line` does
  - `shape`: a custom line, built through the panel's own graph edits (`LineEdit.OPS`). Its stages, in order: a role,
    `{ together: [roles] }` (each gets a copy), `{ turns: [roles] }`, `{ sort: { code: role, research: role } }`
    (everything else goes straight on), and `{ review: true, tries }` after a step
  - `staff`: `{ step, agent, instructions }` in run order, with `"new"` to recruit

A new room is sized for what its zones need, from the engine's own measure of each line and the size of each style's
set: at least 18 × 10 for several zones, at most 44 × 26. Anything bigger is refused with "Split it into two rooms".
With `where` naming an existing plain room, that room is split down the middle, and each zone must fit around what
already stands there. Lines go in first, then the furniture. The whole room lands in one undo.

Sets survive either prop catalog. The page's remastered desk is 3 tiles wide, not 2, so a flat decor piece that would
overlap is left out. The catalog's mount rules hold too (`app.js` hands them to the world model): a lava lamp stands on
its side table, and what may stand on a table can. The tests install the same rules the page does.

## The menus (the only things the model can say)

`station.plan_line`:

| Field | Accepts |
| --- | --- |
| `line` | One of the Lines shelf's tested lines, by id or plain name (read from `WorldModel.BLUEPRINTS`) |
| `shape` | Instead of `line`: a line the Commander DESCRIBED, as stages in order (a role, `{ together }`, `{ turns }`, `{ sort }`, `{ review, tries }`: see Vibe design). It is laid out whole by the layout engine in a new room sized for it, or in an existing room (`where`) around what already stands there. `name` is the line's name, `steps` staff it in run order. |
| `purpose` | The Commander's own words for what the line is for. With no `line`, StarNet picks one with `WorkflowLine.suggestLineFor`, the reader behind FOR YOUR GOAL (the shape of the work: research then writing, a draft and a reviewer, code with tests or a review, two takes), and the card says why. Words with no such shape are refused with the menu. Every step's standard instructions end with `This line is for: "…"`. |
| `where` | `"new room"` (the default), or an existing room by name. In an existing room, every machine and belt must fit on clear floor **inside** it. |
| `beside`, `side`, `hallway` | Where its new room goes, as in the spatial builder. |
| `name` | What to call the line (on its Inbox), up to 48 characters |
| `steps` | `{ step, instructions, agent }` by step number in run order, or `{ role, … }`. `agent` is a crew name or id, `"lead"`, or `"new"` to recruit that role's specialist. A step without instructions gets its role's standard ones. |

**Recruiting** (`agent: "new"`): the card lists it ("It adds 1 crew member: TESTER, with a desk in HOME"). The build
recruits through `Build.summonForRole`, the setup guide's own RECRUIT, after the floor matched its plan and inside the
same undo step. UNDO takes back the recruit's desk and seat but not the agent (DELETE AGENT in its Dossier does), and the
card says so. If a recruit fails, nothing is built, and the refusal names any agent already recruited.
| `dailyCap` | Dollars per day, or `null` for no cap |
| `tries` | 1 to 5 review passes, on lines with a review loop |

`station.plan_room`:

| Field | Accepts |
| --- | --- |
| `kit` | One of the 12 hand-designed rooms the station presets use (`StationTemplates.kits()`), by name or id. A kit with its own line brings that line, with its instructions and nobody hired. |
| `preset` | Instead of a kit: every room of that preset, added beside the station. Nothing already there changes. |
| `replace` | `true` with a preset: swap the whole station for it, exactly as Build mode's Presets does (`StationTemplates.build` → `replaceLayout`, every agent keeps a desk). The page first backs the current layout up to Build mode's own slot, so RESTORE PREVIOUS in Build → Presets brings it back; if the backup fails, nothing changes. |
| `where` | `"new room"` (the default), or an existing plain room of at least 18 × 11 with clear floor, to furnish it. A preset always adds new rooms. |
| `beside`, `side`, `hallway`, `size` | Where a new room goes, as in the spatial builder. `size` is for a room of zones; a kit comes at its own 18 × 11. |
| `name` | A single new room's name |
| `type` | A room type's floor, as in Build mode's TYPE palette (HAB, BRIDGE, LAB, FOUNDRY, QUARTERS, STORAGE): its floor style and material |
| `floorStyle`, `floorMat` | From `WorldModel.FLOOR_STYLES` and `FLOOR_MATERIALS`; they win over a `type` |

`station.plan_restyle`: `room` (its current name), plus `type`, `floorStyle`, `floorMat` or `name`. Nothing is added,
moved or removed.

Anything else is refused with the valid choices. For example, `x` gets: "StarNet chooses every position, belt and piece
of furniture itself, so these fields are not accepted: x".

## Proof

- `test/station-builder.test.js` (fast gate):
  - all 20 lines plan and build in a new room, and one undo restores the station exactly
  - add-only on a station with a working line
  - existing-room placement
  - steps, settings and refusals
  - stale and tampered plans
  - **the bad-model gauntlet**: 400 seeded wrong or hostile line requests, and after every one the station is unchanged, or built with nothing existing moved and one undo restoring it
  - all 12 kits in a new room, each holding exactly its furniture, with doorways clear and one undo
  - every preset's rooms beside a busy station, with the existing line routing as before
  - furnishing an existing room, and refusing one with no clear floor
  - restyle: plan, apply, one undo, and refusals, with room types
  - every preset (all 7) as a whole-station swap on a busy station: exactly the preset's rooms, every agent keeps a place, one undo restores the old station exactly
  - a rooms gauntlet of 120 wrong or hostile room and restyle requests
  - purposes that pick each line shape, a vague one refused, a named line winning over a purpose
  - recruiting: listed on the card, nobody summoned while planning, seated by the build, one undo for the floor, and a failed recruit building nothing
  - vibe design, under both prop catalogs: every style in a half of a new room beside a working line (reachable, one undo, nothing existing moved); line zones of a shelf line, a purpose and every custom stage kind, each machine inside its zone and nothing but staffing missing; four corners; a whole-room style; an existing room split; the card's drawing; recruiting in a zone; 30 refusals; and a vibe gauntlet of 90 hostile zone requests
  - the spatial builder: the ask that failed live (three rooms in one plan, a giant empty hall east of the bridge, then three lines into it as three separate lines); every side with a hallway, open plan and a 5-tile hallway; every size word; six unnamed rooms making a block and not a strip; no wall opened that was not asked for; a hallway sliding clear of furniture; hallways between rooms; rooms north and west of a station with a working line (the origin bug); six lines in one giant hall; 25 refusals; the map, and every size it lists really planning; recruiting; and a build gauntlet of 140 plausible and hostile requests
  - station layouts, under both catalogs: a ring of six and a concourse of eight on a fresh station (every room walkable, none against another, each furnished in its style with its floor and walls, the hall's lines, the corridors dressed, one undo); a ring refused round a crowded bridge; `replace: true` on a busy station (the bridge untouched, every agent a desk, one undo back); a concourse finding a free side; 15 refusals; every style in a room on three sides; a 48-request layout gauntlet
  - the polish pass: `replace: true` over a bridge piled with nine desks (the lead keeps its desk there, the other eight move two to a room, one desk each, never touching, one undo back to the pile); four rooms asked one at a time landing exactly where a diamond of the same four does, each named for its style; a small and a giant room asked with a size keeping the grid; lines with no `where` going into the conveyor hall, else a grid room at least 18 × 11; three lines in one hall, then a fourth, and three more one at a time into an empty hall, every line three clear tiles from the next and a tile in from the walls (the old builder gave one clump: checked); a recruit batch on ONE row; a room of zones with plants in its corners, named on the card; recruits capped at three
- `test/station-builder.e2e.test.mjs` (HTTP gate): a mock lead finds the builder with `tool_search`, then maps, plans and builds through the real sidecar, bridge
  and page in Chromium:
  - a line: the floor, the Workflow panel pill and the Build-mode refusal are checked, and one UNDO removes it
  - a LOUNGE kit holds exactly the kit's furniture
  - a restyle changes the floor and no prop
  - one UNDO each removes the restyle and the room
  - a swap to RESEARCH STATION backs the old layout up, and Build mode's RESTORE PREVIOUS brings it back
  - "fix bugs in my repo and test them" picks Build + test, and `"new"` recruits a real Tester through the page, seated and ready
  - a described line ("research it, then a writer and an analyst at once, then a reviewer") lands as four steps with a split and a join, in its own room, in one undo
  - vibe design: "the left side cozy, the right side a line that builds and tests code" lands with every piece of furniture left of every machine, the lamp on its table, in one undo
  - the ask that failed live, word for word: the lead reads `station.map`, plans an Ops Room north, a furnished Rec Room west and a giant Conveyor Hall east of the bridge in one plan, and builds; each is joined by its own hallway and can be walked into; then two lines go into the hall as two lines; two UNDOs restore the station
- Live, in ask mode, the same three-room build: the card listed each room with its side and hallway, drew all three and their hallways around the bridge, built nothing while it waited, and Approve once built them.
- Live, in ask mode, the design card read "DEN, a new 30 × 10 room beside HOME: the left half, a cozy corner (a bookshelf, a tall plant, a rug, a beanbag, a couch, a side table, a plant and a lava lamp); the right half, Build + test …". It drew the room with its two zones numbered, nothing was built while it waited, and Approve once built it.
- Live, in ask mode:
  - the card read "NOVA wants to build this on your station: Build + test ("SHIP IT") in a new room beside HOME: Engineer (NOVA) → Tester (NOVA) → Outbox · daily cap $5 · up to 3 review tries. It will be ready to run. One UNDO in Build mode removes it." (it now ends "takes it back", which also fits a swap or a restyle)
  - Approve once built it
  - Deny built nothing, and the model was told

  In ask mode the lead first settles its Task Brief (`brief_proceed`), because `station.build` is consequential work.

Custom shapes (the plan's phase 4) are built as line zones. The card draws the plan rather than overlaying the live floor.

Not built: everything Refit mode can do, the lead can now do through REFIT (rooms of any shape, resize, type, exact
pieces turned and flipped, belts, wiring, line edits). What stays out: a station wider than the world model's 240-tile
span, and creating new prop art (the MAKE A PROP flow).
