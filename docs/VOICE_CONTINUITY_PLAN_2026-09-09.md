# Voice continuity repair

Owner-authorized implementation and merge; lane agent/voice-continuity-0909.

Done means streaming a punctuated response in the seeded app preserves complete sentences, injected transient audio failures recover in order, exhausted failures visibly report interrupted speech, and microphone-triggered stops carry measured evidence. Fast gate must pass before and after integration.

1. Prefer sentence boundaries in chat, allow substantial clauses after 1200 ms, remove the second opening splitter. Flush final tails and cancel pending timers on teardown/reset.
2. Retain failed chunks for two synthesis retries and one playback retry. Preserve prefetch order and speaker identity. Exhaustion stops the spoken reply explicitly; text remains available.
3. Keep bounded text-free diagnostic events for synthesis/playback/cancellation. Expose interruption beside the speaker and in Live Voice.
4. Require at least 300 ms sustained above-threshold activity during playback. Log the measured threshold and levels without claiming acoustic identity; preserve native provider turn detection.
5. Exercise buffering, retry ordering, exhaustion, cancellation, delayed results, microphone bursts and deliberate onset. Sync website mirror; run customer journeys and fast gate; seeded browser proof.
6. Merge trunk into the lane without rebasing, gate, snapshot trunk and merge with an explicit human-authored subject. Preserve unrelated integration changes. Record source repair separately from installer and reporter recovery.

Physical speaker echo, real background-noise recordings, provider realtime acoustics and the affected installer remain hardware/customer acceptance checks. Threshold tests alone cannot prove those recovered.
