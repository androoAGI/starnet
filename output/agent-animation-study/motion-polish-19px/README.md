# Natural motion pass — 19 px

The station renderer previously eased heading twice while travel continued, and added a turn arc to the translation odometer. A 180-degree reproduction travelled 3.8 world pixels facing backwards and added 13.19 artificial stride pixels. The corrected reproduction has neither.

The shared catalog runtime now turns before travelling on sharp heading changes, advances leg phase only with translation, preserves phase across pauses, accelerates at compact-body pace and reaches its stop within 0.12 world pixels. Walking glances no longer turn the entire moving body. Existing 19px artwork and frame selections are retained.

Talking keeps feet planted, uses gentle irregular posture accents with eased starts/stops, and gives conversations varied phrase lengths and listening gaps. This is body-language polish, not generated mouth animation or audio lip-sync. The dev preview includes an explicitly labelled talking-pose close-up using the same renderer without changing live agent state.

Validation: test-motion.cjs exercises 570 heading/timestep/skin combinations across all 38 catalog designs, checks translation-only stride distance and phase continuity, checks nonoverlapping conversation turns, and invokes the actual renderer to verify zero speech foot drift and reduced-motion behavior. The full suite is recorded in test-fast.log. Live station observations are recorded separately.
