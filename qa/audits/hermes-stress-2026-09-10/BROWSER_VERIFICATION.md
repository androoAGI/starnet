# Browser verification follow-up

Candidate: c9997b6b9ca35a99d01fa3802cf35ee42112b62e, isolated agent/hermes-stress-0910. User-approved browser-only retry succeeded. No native computer API workaround was used.

## Live findings and repairs

Copy message originally collapsed cells and list items and could include the code-copy checkmark. It now copies the original Markdown retained by both streamed and restored prose. The exact report was copied after reload and an actual sidecar restart; a newly streamed six-column report copied exactly too. Code-block copying separately produced only {"ok":false,"receipt":"731"}.

At a 1000 x 800 viewport, narrow table cells originally split ordinary words such as Status and Backup. Cell word wrapping now respects word boundaries; the existing table container owns horizontal overflow. No whole-page horizontal overflow was observed.

## Coverage

- Default 1280 x 720, narrow 1000 x 800, and expanded 1600 x 1000 layouts; COMMS measured 360 px by default and 639 px after dragging its splitter.
- Semantic headings, column headers, ordered/nested lists, blockquote and safe named link, with screenshots inspected in this task.
- Wide table retained six columns: 791 px content inside a 216 px narrow container. Mouse scrolling reached scrollLeft 576, exposing the final Next action column. Keyboard ArrowLeft moved 201 to 161 on the focusable table container.
- Controlled provider streamed 60-character chunks every second. History scrollTop stayed 0 as the transcript grew; selected Audit result text survived from working through completion.
- Reload and real process restart retained the report. Streamed and restored message copying preserved exact Markdown, independently from code copying.
- Browser console error query returned an empty list.
- Focused renderer/copy regression: 33 assertions. Full fast suite: 757/757 steps, exit 0. Prior backend HTTP receipt remains 110/110; backend files did not change in this follow-up.

The model/provider was a local controlled fixture, so these are runtime/UI checks rather than live-model quality measurements. App UI zoom remained at its default; this is not an all-window, all-zoom, installed-desktop or station-wide readiness claim. The temporary tab was closed, viewport override reset, and only the verified test process tree stopped.

See browser-receipt.json for measurements and the fast-log hash. The remaining work is integration, the same-model comparison after model/provider and spending approval, and the subsequent soak.
