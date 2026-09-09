# White shell for fresh starter stations

- Owner request: make the white SHELL finish selected in the fresh preview the new-user default. Saved preview value was `hullStyle: bone` (`#e7e3d9`).
- Source change: one assignment in `WorldModel.starterDoc()`, plus the generated website mirror and mechanical source receipt. Existing saved stations and new-room construction defaults are untouched.
- Source commit: `3d967cd0cdc50518bff10ac9bb6e0e482df0cf48`; candidate `aa0316a00cdc6ec80755a8236e76083e34d1ea48`; merge `f68403588a5f74d7f9cacc2bcf8c4de556fa050d`, from trunk `f672e33e3676ffe6e1b6de7de6eadb3f93db6f42`. Candidate and merge trees are identical.
- Pre-merge and post-merge `npm run test:fast`: **744/744 GREEN**, exit 0. Frontend-only default change; HTTP gate not required.
- Live proof: a separate seeded workspace started with station:null and used the real App.enterGame -> starterDoc path. Rendered HAB-01 is 14x9 with crate, rack, plant, assigned desk and one default agent; no belts. Shell is bone/station; floor and walls retain their defaults. Disk save retains bone. Browser diagnostics: no exceptions or console messages.
- Grade, CRT settings and prop layout match the previous approved fresh-station proof. Screenshot visually inspected. Evidence: `C:/Users/andro/gen-trees/world-next-0907/.uishots-starter-white/`; gate logs in that worktree's `.tmp/starter-white-{fast,trunk-fast}.log`.
- Temporary verification server on 9211 stopped after proof; the owner's 9207 and 9210 previews remain available.
- No installer build, installed-app check, push or release performed. This is lane verification, not a station-wide readiness claim. Existing foreign QA status and Rooms handoff edits remain unstaged.
