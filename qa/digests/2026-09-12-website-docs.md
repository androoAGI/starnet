# Website and documentation reorganization

Lane: `agent/website-docs-0912`, based on integration `a7ae9f23e`.
Implementation: `df77a1426` and `626e4798c`.

The public website had 24 documentation pages under broad, overlapping navigation buckets,
an exhaustive card directory, and 15 equally weighted homepage features. This lane gives each
article one topic, differentiates guides from reference, and replaces the directory and guide
library with explicit entry paths. Existing page URLs remain available.

The six topics are Start here, Station & agents, Conveyor workflows, Repeat & automate,
Connect your tools, and Troubleshooting & help. The manifest in `scripts/website-shell.mjs`
owns navigation, article titles, the topic directory, section search index, and within-topic
pagers. Run that script after changing documentation content; `--check` detects drift.

Docs use plain reading type, higher contrast, native collapsible topic groups, and a responsive
sidebar. Illustrations retain the station's pixel style. Search indexes local article sections
and links to their anchors, supports keyboard navigation and an explicit empty state, and makes
no network requests. Article anchors are present in the static HTML. A broken existing
`somethings-not-running` help link now has a compatibility anchor.

The homepage has six feature summaries and three documentation paths. Its blocking boot overlay
is removed. First-run and installation copy follows the current two-step Overseer setup in
`frontend/app/overseer-setup.js`. The public version fallback is 0.11.2, verified against
[the public release](https://github.com/androoAGI/starnet-releases/releases/tag/v0.11.2).
Raw release labels are generated from the same fallback used by `website/site.js`.

## Observed browser behavior

- All 24 source docs pages checked at 390, 768, and 1440 CSS-pixel viewport widths: no document
  horizontal overflow; one main heading per page. Mobile illustrations had no broken image loads.
- Mobile menu opened; Conveyor workflows expanded; selecting Build your first workflow opened
  the nested guide with the menu reset to its closed state.
- Searching `Gatekeeper`, pressing ArrowDown, then Enter opened
  `docs/getting-started.html#macos-first-run` with the section positioned below the header.
- Unknown search displayed an explicit empty state; Escape closed results; a code-copy button
  reported Copied. The guide library exposed all nine walkthroughs.
- A direct link to `docs/index.html#automation` opened the correct topic. Reloading the updated
  quickstart at `#connect-a-provider` positioned its heading at 100 CSS pixels.
- The staged docs were served with `script-src 'none'`: article content and native topic expansion
  still worked; inactive search controls were hidden.
- Staged homepage showed 0.11.2, six features, three docs routes, and the rendered station iframe
  with two canvases. Source-only `website/` lacks the generated `app/embed.htm`, so the deliverable
  preview serves `website-deploy/` instead.

## Checks

- Syntax checks: all modified JS/MJS files passed; `git diff --check` passed.
- Shell regeneration: 31 pages, 0 would change, 24 indexed.
- Documentation navigation: 1,347 assertions, including 1,103 internal page links, passed after
  the final quickstart edit.
- Initial website slice: five suites passed (pricing hold, docs navigation, deploy staging,
  app synchronization, and live preview), 1,406 assertions before the final copy refinement.
- Final copy refinement: navigation 1,347 and deploy staging 25 assertions rechecked green;
  the other three website suites are unchanged. All 36 modified publishable website files
  in the staging directory were byte-compared with committed source; zero mismatches.
- Full gate: **NOT GREEN / INCOMPLETE**. The Node 24 `npm run test:fast` run hit its
  900,000 ms watchdog on this shared host before finishing all 772 manifest steps.
  Its log reports `[timeout] test:fast exceeded 900000ms; terminating process tree.`
  This is not an assertion-failure-free full-suite receipt and does not permit integration.
  Raw log: `.dogfood/fast-node24.log`. The fresh worktree initially lacked `ogg-opus-decoder`;
  `npm ci --ignore-scripts` installed the locked dependencies. Node 22.23.0 then produced varying
  failures in unchanged `voice.button.test.js`. Its standalone Node 24.19.0 run passed 140/140,
  and the full Node 24 rerun passed that suite as well. No voice source or tests were changed.

The local deliverable preview is `http://127.0.0.1:8925/docs/`, served from the isolated
worktree's staging directory by the owned `.dogfood/preview.py` helper (PID 42396 at launch).
The earlier source-only server on 8924 was stopped. Preview tabs unrelated to the deliverable
were closed and viewport overrides reset.

No integration merge or publication was performed. This is website behavior verification;
it does not certify every pre-existing documentation claim or the installed desktop product.

## Visual correction — StarNet glass (2026-09-12)

The user rejected the initial sans-serif / olive documentation styling and requested the
StarNet identity with the current app glass treatment. This revision supersedes that visual
direction while retaining the six topic groups, existing URLs, search and reading layout.

- Restored self-hosted VT323 for headings, article text, navigation and metadata; code and
  keyboard combinations retain a conventional monospace face. Restored amber phosphor
  colors and the existing CRT layers with restrained static opacity for reading.
- Reused the production `frontend/css/menu-glass.css` 125-degree translucent gradient,
  phosphor RGB values, inset rim highlight and 12px backdrop blur. Applied the material
  to the docs header, sidebar, entry cards, topic cards, guide diagrams and article callouts.
- Versioned the stylesheet and script references as `20260912-glass` through the shell
  generator. No documentation content, navigation behavior or application code changed.
- Browser proof against the staged website on port 8925: all 24 documentation pages at
  390, 768 and 1440px widths, one H1 each, no document overflow. The first tablet sweep
  identified 16px of article overflow on keyboard shortcuts; switching those rows to a
  single column at tablet width resolved it on recheck. All mobile images loaded.
- Visually inspected the docs landing page, installation article and illustrated first-workflow
  guide. Verified loaded VT323 and computed 12px sidebar blur in the running browser.
- Keyboard search for `Gatekeeper` opened `getting-started.html#macos-first-run`; the heading
  appeared at 120px, below the 72px desktop header. Mobile menu open/close and native topic
  expansion worked. With script execution blocked by the preview helper, navigation and
  native topic expansion remained usable and the inactive search stayed hidden.
- Five website suites passed: pricing hold 14, navigation 1,347, deployment staging 25,
  app synchronization 8, live preview 15 (1,409 assertions). Shell check: 31 pages,
  zero changes needed. The earlier incomplete full-repository gate remains incomplete;
  this CSS correction does not claim a green integration gate or authorize a merge.

This correction remains in the isolated website worktree and local preview; it is unpublished.

## Lighting refinement — continued glass concept (2026-09-12)

The user accepted the concept and reported that the lighting looked buggy. Live inspection
showed a page glow, a second hero glow, translucent card gradients and a foreground vignette
compositing together. The docs now use a restrained background light behind the content,
dark-backed glass and a reflection with fixed pixel stops. Expanding a panel no longer
stretches its reflection across the new height. Reduced heading bloom and integer responsive
font sizes retain the phosphor identity without fractional scaling of the pixel face.

- Live proof: 72 checks (all 24 pages at 390, 768 and 1440px), no document or article
  overflow, atmospheric overlays behind the content, integer H1 sizes at each breakpoint.
- Visually inspected the landing page, expanded topic directory and mobile installation
  article. The automation topic grew from 162px to 372px with the same reflection definition.
  Body copy has no text shadow. Mobile menu open/close and keyboard search worked;
  `macos-first-run` landed at 120px below the 107px mobile header.
- Navigation suite: 1,347 assertions, including 1,103 internal links; staging suite: 25
  assertions. Shell check: 31 pages, zero changes needed. Diff whitespace check passed,
  and the staged stylesheet hash equals source. The full repository gate was not rerun
  for this CSS refinement; its earlier incomplete result still prevents integration.

Saved locally in the existing owned worktree; no merge or publication.

## Organization and alignment (2026-09-12)

- Replaced the collapsed topic directory with six visible sections containing all 22
  article links and their guide/reference/help labels. Existing topic and article URLs
  remain valid. The first-run path is shorter, with one action per step.
- Promoted Docs overview and Step-by-step guides to permanent sidebar links and removed
  their duplicates from Start here. Removed the redundant landing-page breadcrumb.
- Unified guide and reference column widths, header gutters, sticky rail positions and
  card padding. Shared CSS grid rows align onboarding labels, titles, descriptions and
  actions, and align each pair of directory cards without fixed heights or clipped text.
- Live browser: all 24 pages at 390, 768, 1280 and 1440px (96 checks) had no horizontal
  document/article overflow, one H1 and one current-page marker. At each width every page
  shared the same article left edge; brand/sidebar left edges and sidebar/contents-rail
  top edges matched. Visually inspected overview, mobile navigation and illustrated guide.
- At 1440px the three setup cards measured 210.97px high, with identical internal row
  positions. At the normal 1049px preview width they measured 264.95px, again with all
  corresponding rows aligned despite title wrapping. Directory card pairs also share
  matching heights and article-list start positions.
- Script-free mobile overview exposes all 22 article links and both overview destinations.
  Mobile navigation successfully opened the guide library. A 320px check caught the
  GitHub arrow wrapping; nonwrapping labels and a smaller mobile nav gap restored the
  107px header. Direct topic links clear that header at 120px with no overflow.
- Five website suites passed: pricing hold 14, navigation 1,323 (1,079 internal links),
  deployment staging 25, app synchronization 8, live preview 15. The lower link count
  reflects the removed duplicate overview link on each of the 24 pages. No full-repository
  gate rerun or integration claim; the prior incomplete gate still applies.

The shared manifest generates the sidebar and directory. This remains a local unpublished revision.
