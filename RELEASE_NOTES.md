# StarNet v0.11.2

Released September 11, 2026. This update expands agent personality and setup, refreshes the station's worlds and walking animations, improves report readability, and repairs save, provider, delegation, graphics and desktop-update behavior.

These notes cover the changes shipped since **0.11.1**, including the final CRT static controls and Windows pointer repair.

## Station visuals and performance

- **Six rebuilt backdrops:** THE NURSERY gains layered gas clouds, filaments, dust and twinkling cores; NIGHT CITY gains a lit street grid, building windows, rivers, bridges and beacons; OCEAN gains stepped waves, crest lines, reflections and pixel clouds; THE BELT gains detailed small asteroids and dust; THE MOON gains richer regolith, crater rims, ejecta and rocks; FOREST gains a dark aerial canopy, conifers, undergrowth, forest-floor detail and a river.
- **Backdrop lag repair:** heavy sky artwork is generated in a background worker, keeping the interface responsive while the scene is prepared. Ground scenery is cached rather than repainting every overlapping tree on every frame.
- **Smoother camera movement:** the ground cache moves with the camera and refreshes when zoom, window size or station footprint changes. Superseded artwork requests are discarded, with a compatibility path for environments without workers.
- **Adjustable CRT static:** Appearance settings now let you change and save static strength. The default remains 100%, preserving the existing look for stations that have not changed it.
- **Smoother walking animations:** expanded walk cycles add intermediate frames across agent skins, with turning cadence adjusted to preserve natural foot motion. Turtle rear-facing frames and wizard staff continuity receive specific corrections.
- **More consistent glass styling:** task-understanding, noticed/recommendation, away-work, decision and other transient cards now match the station interface. Station announcements are more readable, and compact recommendation labels remain compact.
- **Panel sizing stays saved:** docked panel height survives close/reopen and reload, with appropriate handling for maximized panels and smaller windows.

## Overseer creation and agent personalities

- **Rebuilt Overseer setup:** a full-screen, two-step identity-and-connection flow brings the character gallery, name, personality, working style, provider, model and reasoning controls together.
- **Clearer connection choices:** StarNet account setup has a prominent branded action; alternative providers use recognizable local logos. Model selection supports keyboard navigation, custom endpoints and saved reasoning choices.
- **Six distinct personality presets:** Composed, Warm, Blunt, Dry, Unhinged and Upbeat now define more consistent behavior in conversation, disagreement, uncertainty, failures and successful work.
- **Detailed personality tuning:** adjust warmth, humor, formality, answer length and energy; choose no, occasional or frequent profanity; control emoji and directness; or write a custom communication style. Personality tuning is separate from the audible voice.
- **Visible saved overrides:** customized personalities are labeled, tuning survives preset changes, and Reset to Preset clears overrides. Older personality names map to the new presets. Unhinged's language choice retains an explicit confirmation.
- **More reliable setup navigation:** going back preserves identity, appearance and connection entries. Replaying the tutorial preserves the current agent name. Narrow-window layout fixes prevent character and identity sections from overlapping.
- **Clearer setup recovery:** stale provider-specific warnings and buttons retire when the connection, agent or missing setup step changes. A connected station without a model shows CHOOSE MODEL and opens the picker instead of asking for an unrelated API key. Recovery buttons work with both mouse and keyboard.

## Providers, connections and discovery

- **GitHub device sign-in:** connect GitHub through its device authorization flow, with a visible code, expiry/cancellation handling and useful sign-in errors. Small windows keep the code accessible. If saving a new token fails, the existing connection is preserved.
- **Discover improvements:** popular platforms are easier to find, with clearer guidance into each platform's connection setup.
- **Field Manual connection guide:** work-app connections and messaging channels have dedicated setup guidance and navigation to the relevant panel.
- **Provider presentation:** refreshed provider logos, aligned connection statuses and clearer StarNet account actions make connection choices easier to scan.
- **Model-selection race fixed:** an older model-catalog response can no longer overwrite a newer provider or model choice, including overlapping picker requests and agent changes.
- **Codex-to-OpenRouter fallback fixed:** saved fallback choices now switch the provider route and credential source correctly when Codex reaches its quota. Paid fallback work retains its configured spending limits and cost record. Addresses [issue #12](https://github.com/androoAGI/starnet/issues/12).
- **Claude continuation fixed:** verification reminders and later host notes retain their proper place in the conversation on OpenRouter and compatible managed connections, avoiding the unsupported assistant-prefill request that could interrupt a task with HTTP 400.
- **Delegated connector access fixed:** specialists retain access to connected MCP tools through the lead agent's live approval flow, including dispatched, spawned and resumed work. Denials, connector removal and renewed confirmation after external content still apply. Addresses [issue #13](https://github.com/androoAGI/starnet/issues/13).

## Saves, conversations and recovery

- **Concurrent-save protection:** stale clients cannot silently overwrite newer station edits. Conflicting local changes are retained for recovery, including edits made while conflict recovery is already open.
- **Startup recovery:** an unsynced local cache no longer prevents startup. Save-recovery actions use the station's own controls and retain the local recovery path.
- **Queued-save restart repair:** completed queued writes now retain the server's acknowledged revision, preventing false conflicts when the station restarts or updates.
- **Conversation conversion preserves attachments:** converting a direct conversation to a group retains historical attachment references and snapshots the required files before committing. If an attachment cannot be read, the original conversation remains intact.
- **Conversion retries are safe:** retrying the same conversion returns the existing result; a different request cannot accidentally reuse the earlier conversion's identity.
- **Duplicate restored replies fixed:** reopening a completed conversation reconciles locally combined streaming text with its durable turns instead of displaying both. Uncommitted text, attachments and stopped/error markers remain available.
- **Loop review isolation:** reviewing or undoing a loop iteration is protected against simultaneous execution, another review, or changes to the same loop, including while Git undo is still running.

## COMMS, reports and task feedback

- **Structured reports in COMMS:** tables, ordered and nested lists, quotations and named links now render alongside headings, emphasis and fenced code.
- **Readable narrow reports:** wide tables stay within their own scrolling area, and table text remains readable at narrower panel widths.
- **Exact report copying:** copying a message preserves its original report text and Markdown; code-block copying retains its separate behavior.
- **List-format fixes:** plus-sign bullets and tab-separated list markers now render consistently during normal report display and restored history.
- **Clear failed-session marker:** failed sessions use a flashing X without repeating the same failure label beside it.
- **Truthful partial results:** failed or interrupted tasks retain the text, usage and evidence already produced instead of being presented as successfully completed work.

## Crew movement, furniture and station behavior

- **Doorway routing repaired:** agent footsteps follow traversable doorway paths instead of cutting through adjacent walls or floor boundaries.
- **Continuous movement and facing:** waypoint transitions remain continuous, and look-back facing is held correctly instead of snapping prematurely.
- **Unreachable desk recovery:** agents wait in place while real work remains active, retry routes and recover when a refit restores access. Moving a desk no longer teleports the Overseer to it.
- **Correct desk-facing poses:** seated crew face their desk, using an appropriate directional pose when a skin lacks matching typing art. Working agents without a seat remain standing.
- **Furniture cleanup:** moving, rotating or deleting furniture releases stale seating claims, offsets and leisure references. Unchanged couches keep their occupants when the station origin shifts.
- **Retired crew releases seats:** removing plan-derived crew frees its furniture reservation so another agent can use the seat.
- **Room deletion stays coherent:** intersecting furniture and belt tiles are removed in the same undo snapshot, while neighboring furniture and logical agent links are retained. Undo, redo and reload preserve the intended result.
- **Approval waits are visible:** crew awaiting permission stand with the waiting-for-approval state and suppress work effects. Matching responses, concurrent prompts and terminal events clear the correct wait.

## Images, usage and speech

- **Image costs reach run receipts:** actual image charges are included in local usage and completed-run costs without charging a second time.
- **Image cancellation stops publication:** cancellation propagates through generation, download and processing so a later result cannot publish a file after cancellation. Upstream work that has already been billed can still incur a charge.
- **Clearer image setup guidance:** BYOK users are shown the supported OpenRouter credential route, instead of only being told to connect a paid StarNet account.
- **Image cleanup diagnostics:** unexpected failures while cleaning staged image files are reported rather than silently hidden.
- **Speech output recovery:** live speech playback recovers after an output-device interruption.

## API and automation reliability

- **Durable chat-completion retries:** compatible clients can send Idempotency-Key to reserve work before execution. Matching concurrent requests share the same run, and completed responses can be replayed after restart without repeating the work.
- **Explicit retry conflicts:** reusing a key with different request content or model configuration returns a conflict. An interrupted reservation without a durable result also returns a conflict rather than silently repeating possible side effects. Disconnecting one waiting client does not cancel shared keyed work.
- **Retryable admission and streaming:** pre-dispatch concurrency rejection remains retryable, streaming retries preserve their original run, and listener failures produce diagnostics.
- **Honest API outcomes:** responses expose native completion status, reason, partial output, errors and usage. Cancellation, output limits, missing terminal events and provider failures no longer masquerade as successful completion.
- **Validated JSON responses:** json_object and json_schema results are validated as complete JSON. A failed result gets at most one output-only repair, which cannot execute tools or repeat task side effects; usage includes both calls.
- **Safer result contracts:** validation supports bounded schema constraints and local references across API and delegated result paths. Unsupported schemas, recursive/remote references and excessive validation work are rejected explicitly.
- **Paused-routine lifecycle fixed:** paused routines no longer count as armed background work or keep an otherwise idle station running after its window closes.

API scope: keyed retry protection applies to /v1/chat/completions, not /v1/runs creation. Structured JSON currently requires stream: false; structured streaming is rejected before work starts. Completed retry records become eligible for cleanup after 24 hours. See the [API documentation](https://github.com/androoAGI/starnet/blob/v0.11.2/docs/OPENAI_COMPAT.md) for the full contract.

## Desktop, installation and diagnostics

- **Windows pointer actions repaired:** move, click, double-click and drag now invoke the intended pointer implementation instead of failing through PowerShell's filesystem-move alias.
- **Consistent installed version reporting:** the desktop shell supplies its actual package version to the local runtime during startup and recovery, keeping installed-app identity and update checks aligned.
- **Linux build packaging repaired:** incompatible musl image binaries and unused GPU accelerator plugins are excluded from the relevant desktop staging paths while required CPU libraries remain. This is a packaging repair; this release's public downloads are Windows, Apple Silicon Mac and Intel Mac.
- **Safer diagnostic logs:** failure-warning tags and messages redact credential-shaped content before logging.
- **Website demo parity:** the corresponding interface, artwork and behavior changes are synchronized into the website's app mirror.

## Installation and release verification

- Signed Windows installation and both notarized Mac builds passed the release train. Intel Mac installed launch and legacy station recovery were checked.
- Final Windows clean-install and packaged lifecycle checks passed, including idle close, close-to-tray and updater behavior.
- Manual upgrades from public 0.11.0 and 0.11.1 passed. The actual public **0.11.1 → 0.11.2 Update Center download, install and automatic restart** also passed, preserving the populated test station and credential availability.
- A populated personal Windows installation passed **534 preservation checks after installation and again after restart**, covering crew, props, conversations, settings and the paused routine. Installed interface smoke passed **9/9**.
- Final source checks included **771 fast regression steps**, **113 HTTP test steps**, customer journeys and focused graphics, save, routing and installer regressions. The usual extended soak durations were waived for this update in favor of these focused checks.
- Release tooling now distinguishes installed smoke from soak acceptance, checks visual findings against current evidence, and accounts for legitimate routine catch-up ticks. Shared HTTP gate deadlines and controlled hydration-test timing reduce false test failures without removing checks or changing product timeouts.

Google Workspace connector availability remains deferred while verification is completed. Google login for StarNet billing is separate. Engineering fixes are verified on the reproduced paths; the three historical reports without an established cause remain tracked rather than being claimed as confirmed customer recoveries.

[Full source comparison: 0.11.1 → 0.11.2](https://github.com/androoAGI/starnet/compare/v0.11.1...v0.11.2)
