---
fingerprint: 891e15e8
slug: queued-save-acknowledgements-leave-browser-revis
title: Queued save acknowledgements leave browser revision stale
surface: sessions
severity: P1
status: fixed
found: 2026-09-11
lane: release-0112-finalprep-0911
fix: 767a3592516edea1062d82855be2d21a8b4f7e16
origin: audit
---

# Queued save acknowledgements leave browser revision stale

## Symptom

Two successful queued station saves can leave the browser cache dirty with an obsolete revision. A normal installed-app restart then reports a false save conflict. The durable station and conflicting local copy survive, but subsequent saving and update readiness are interrupted.

## Repro

Reproducer: `test/cloudsave-concurrency.test.js`. Defective acknowledgement seam: `frontend/app/cloudsave.js:140`.

Write the browser cache as App.persist does, send one save, and queue another before its acknowledgement. Wait for both writes, restart with that cache, and save again. The first acknowledgement updates the queued in-memory revision, so the final acknowledgement's comparison against localStorage incorrectly fails.

## Evidence

Hosted Windows installed-app run [34567303092](https://github.com/androoAGI/starnet/actions/runs/34567303092) upgraded the published 0.11.1 installer to signed candidate source 61528ba957fade1872726f342dfae3d768401c38. Populated state survived installation. After normal close/restart, the receipt recorded localRevision 0, durableRevision 2 and a refused stale write with a preserved recovery file. This was a real application defect after earlier fixture corrections.

The added regression failed before the fix with browser revision 6 versus durable revision 8. It passes after the fix, including a subsequent restart/write and a negative case ensuring that an acknowledgement cannot mark a different, unsubmitted edit clean.

## Fix

Compare the acknowledged document with the browser cache excluding only transport client/revision metadata. Matching user content receives the acknowledged revision and becomes clean. Different content remains dirty. Server compare-and-swap and conflict recovery remain in force.

## Regression

`test/cloudsave-concurrency.test.js` covers two clients, conflict export, update refusal, offline restart, queued cache acknowledgements and protection of newer unsubmitted content. The website's bundled CloudSave copy matches the frontend. The dev-seeded browser check passed matching revisions 12/12 after queued writes and 14/14 after reload, with a successful update drain and no conflict or browser exception. Fresh signed-installer restart verification is pending; the previous failed receipt is retained.
