# Skill Market uploads — runbook

Anyone with a StarNet account can share a skill. This is how one gets from their upload to every station.

```
author                         account.starnetos.com            this PC (has the market signing key)          starnetos.com
SHARE YOUR SKILL (market.html) ─▶ ACCOUNT › SKILLS: upload ─▶ /admin/skills: APPROVE ─▶ pull-skill-submissions.mjs ─▶ website deploy
                                   (waits for review)         (or send back w/ a note)     build + scan + SIGN            (live catalog)
                                                                                           ◀── --mark-live: author sees LIVE
```

## One-time setup

1. Make a review token and keep it next to the signing key:
   `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))" > %USERPROFILE%\.starnet-keys\skill-review.token`
2. Give the cloud the same value: `fly secrets set SKILL_REVIEW_TOKEN=<value>` (starnet-cloud). Unset = the pull
   door (`/v1/skill-submissions/*`) 404s; uploads and the review queue still work.
3. Deploy starnet-cloud with schema v5 (`skill_submissions`). As with every migration, an older build refuses the
   migrated database: roll back by redeploying this build, not an older one.

## Each batch

1. **Review**: account.starnetos.com/admin → *Skill submissions*. Read the whole package (it is shown exactly as it
   will ship). The quick-scan flags are hints; the real scan runs in step 2. Approve, or send back with a note.
2. **Pull**: `node scripts/pull-skill-submissions.mjs --dry-run`, then without `--dry-run`. It writes
   `skills-catalog/skills/<slug>/`, credits the author in NOTICE.md, and runs `build-skill-catalog.mjs` (which needs
   the signing key). It refuses a name StarNet or another author already uses, a package that differs from what you
   approved, and anything the skill guard rates dangerous. If the build fails, every file is put back.
3. **Commit** `skills-catalog/`, `NOTICE.md` and `website/` on a branch, gate, merge.
4. **Deploy the website** (`website-deploy`, never `website`). ⚠ A website deploy publishes ALL of trunk's
   `website/`, including any unreleased pages; the standing rule is that the website deploys with an app release
   (memory: skill-market-plan, DEPLOY TIMING). Batch uploads into a release, or check `git diff <last-tag> -- website/`
   shows nothing unreleased besides the catalog before deploying between releases.
5. **Mark live**: `node scripts/pull-skill-submissions.mjs --mark-live`. It only marks skills the LIVE catalog lists
   at the exact version and digest just built; their authors then see LIVE on their Skills tab.
6. `node scripts/build-skill-catalog.mjs --pin-floor` and commit `market-floor.json` (it ships in the next app build).

## Pulling a bad upload after it is live

Same as any market skill: add it to `skills-catalog/revoked.json` with a reason, remove its folder (or ship a fixed
version), rebuild, deploy. Stations switch it off within minutes.

## What the author sees

WAITING FOR REVIEW → APPROVED (goes live with the next catalog update) → LIVE · vX.Y.Z, or NEEDS CHANGES with your
note. They can withdraw a waiting upload; a withdrawn or sent-back name is free again. At most 3 waiting per account.
