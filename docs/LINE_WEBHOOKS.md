# Line webhooks

Create a webhook in the existing line trigger form. POST to `/api/hooks/<triggerId>` with its secret in `X-StarNet-Hook-Key`, `Authorization: Bearer <secret>`, or the existing `?key=` URL parameter. Authentication happens before the request body is read. A trigger secret does not authorize the station's management API.

A successful request returns HTTP 202 with `jobId`, `streamId`, `durable:true`, and its admission queue position. This confirms that the LineJob is on disk, not that its work has completed. Read `/api/line-jobs/<jobId>` through the authenticated station API for the current result. The job follows the same line, provider settings, spending limits and authority as other trigger work.

Send an optional `Idempotency-Key` containing 1-256 printable characters. The key belongs to this trigger, and the exact request body and content type are bound to it. Concurrent identical requests share one job and replay its accepted response. Changed content under that key returns 409. Another trigger has a separate key scope. Without the header, each POST is a separate delivery.

Accepted keyed responses include `idempotencyExpiresAt` and `idempotencyRetentionHours:24`. The minimum retention window starts when the acceptance response is durably recorded. At that timestamp the completed receipt becomes eligible for pruning by a later new admission; the same key may still replay until pruning occurs. After pruning, reusing its key may create new work. This is the existing request reservation owner's 24-hour cleanup policy. Use a new delivery key for an intentional new delivery. Unfinished reservations with no durable response never expire into permission to repeat work.

A lost response can be recovered only when the original reservation and the exact durable job agree on trigger, reservation identity and payload fingerprint. Missing or conflicting evidence returns 409 and does not create a replacement job. An unavailable or recovered reservation store refuses dispatch. Retry a transient 503 with the same key; do not switch keys merely to bypass an uncertain delivery.

A station restart marks unfinished jobs interrupted. Replaying a known delivery returns the same job identity; it does not restart the paid walk. Queue positions in a replay are the original admission position, not a current progress estimate.

To cancel, use the station-authenticated `DELETE /api/line-jobs/<jobId>`. It stops only that job's actual owner. A queued job settles stopped without a provider call. A running stop returns 202 while the owner unwinds, or 200 once stopped; `stopRequested` does not claim that cancellation has already finished. A finished job remains readable, and an unowned live-looking record returns 409 instead of cancelling unrelated work.

If storage refuses the final job record, the job keeps its existing identity and occupies its queue slot until that record can be saved. Cancellation reports a storage failure while the write still fails. After storage recovers, retrying cancellation saves the same job's stopped result with any work and spend already recorded; it does not run the provider again. Following queued work resumes only after the held job settles. A station restart still applies the interruption rule above.
