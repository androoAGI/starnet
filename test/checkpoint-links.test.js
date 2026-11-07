/* node test/checkpoint-links.test.js — a checkpoint never reads, writes or deletes THROUGH a link (lane checkpoint-links,
   review rounds 1-6, 2026-10-30; sidecar/checkpoint-store.js, the header's LINKS and restore's WHAT A REWIND REMOVES).

   Git for Windows walks a junction as if it were a plain folder. Before this lane, on trunk d5024f5a:
     A  a junction in the workspace pointing at a folder outside it was captured: its files became 100644 blobs of the
        snapshot (jx/secret.txt), health stayed ok and no row said a link was there;
     B  a tracked folder swapped for a junction was re-read through it under the old tracked names;
     C' F  restore's `reset --hard` then DELETED the real files behind a junction (a folder, or a tracked file, swapped for
        one) and reported ok:true; with the target's files under a junction it WROTE through it;
     E  the npm-link rewind: node_modules/mylib a junction to a sibling ../mylib, rewound to a turn before the link:
        mylib/index.js and mylib/src/core.js deleted, restore ok:true.
   Every capture now goes through ONE boundary (prepareCapture: the walk that never follows, the exclusion, the dropped
   tracked descendants, the recorded links): a normal snapshot, restore's pre-restore capture and the size-ceiling re-init.
   Restore refuses, before anything is touched, a path it would write or delete through a link.

   Every row below runs against a REAL temp work tree and REAL git, but for section 10 and the last two blocks of row 19:
   source-text locks (the scope statements, the restore route's answers, the slow.list entry) beside one control of
   Node's own fs.rmSync (the SSH mirror wipe's loop, copied: it says what Node does, so it is green on trunk too).
   The rows run eight at a time (runRows), each on its own agent id, work tree and outside folders, so none reads
   another's state; sections 2 and 3 share one fixture and are one row. test/helpers/checkpoint-rows.js says how they
   run and how Git is started. Fixtures: junctions (Windows) or directory
   symlinks (POSIX) made only inside this test's own os.tmpdir() folder, pointing only at sibling folders it made;
   removed with `cmd /c rmdir` (Windows) / unlink before the folder is deleted. A volume mount point needs no
   administrator rights (FSCTL_SET_REPARSE_POINT on an empty folder the person owns), but a live one is a plain folder
   to lstat, so a cleanup that missed it could delete through it into that volume; and Node's own junction call, given a
   \\?\Volume{GUID}\ target, writes it without the last backslash, which lstat answers with ELOOP (a GUID naming no
   volume), not the ENOENT the review's, made with that ioctl, gave. Section 8 therefore drives the classification
   through an injected fs that reports an entry exactly as libuv reports a volume mount point (a reparse point in the
   listing, a plain folder to lstat; a dangling one, nothing at all): the answers review minors got from real ones,
   live and dangling (Node 22.23).

   RESIDUAL (out of scope, the run-paths threat model; same note as the store header): a folder swapped for a link in
   the moment between the walk and Git's own read of it is still followed (TOCTOU, a hostile same-user actor). Tier 2,
   lane "checkpoint-manifest" (a checkpoint-owned manifest + a native Windows no-follow adapter, joined with the claims
   gap W2-link-junction-containment), closes it.
   Review round 2 (rows 11-15): P8, a target that holds a FILE where a folder with a link below it now is (reset empties
   that folder through the link before it writes the file; also inside an ignored folder or an embedded repository);
   restore's clean, which unlinked a link the target's .gitignore re-includes (P2) and removed a folder only the current
   .gitignore ignored, link and never-captured files with it (P1); an embedded repository holding a link, which made
   every later capture and rewind fail (check-ignore and add die on a path below a gitlink) and cost the walk its whole
   budget; link order that changed with I/O timing, so an unchanged tree never deduped; and a POSIX root reached through
   a link, which made every folder a mount point.
   Review round 3 (row 16): P8 one level INSIDE a folder the walk does not enter (the target holds a FILE at build/sub
   under an ignored build/, or at proj/sub inside an embedded clone; reset emptied the folder behind sub/jl and the
   rewind said ok); a `.git` that is itself a junction in a folder the walk enters (never a recorded link, as Git never
   reads it; reset emptied a relocated git-dir through it); a `.git` FILE Git does not read as a gitfile (no space,
   two spaces or a tab after "gitdir:", or a second line), which the walk took for an embedded repository and skipped
   while Git read the folder and a junction in it (introduced by round 2's embedded-repository walk); and restore's
   clean, which needed one pattern per ignored folder, so 700 __pycache__ folders with no link refused every rewind
   (introduced by round 2's keptInPlace; round 3 made it one pattern per .gitignore rule).
   Review round 4 (row 17): P8 through a link INSIDE a real `.git` folder, which neither the walk nor the check ever
   listed (entry.c remove_subtree has no case for `.git`): the target holds a FILE at proj, now a clone whose .git/hooks
   is a junction to a shared hooks folder, or at x, now a walked folder whose plain .git holds a .git/lfs junction; reset
   emptied both outside folders and the rewind said ok. And restore's clean, whose one pattern per .gitignore rule was
   still one per package .gitignore: a monorepo of 400 packages each listing dist/ and .turbo/ refused every rewind
   (introduced by round 2's keptInPlace, narrowed in round 3; round 4 made it one pattern per ignored folder name).
   Review round 5 (row 18): restore's clean deleted for good files no capture took: an ignored .env, a *.log, a folder a
   glob rule ignores, once reset had written a target .gitignore without the rule (trunk d5024f5a did the same). A
   rewind now runs no clean at all, so keptInPlace and its bound are gone (everything clean could still delete after
   the pre-restore capture was such a file). Also: the claim that a `.git` junction, or a link inside a plain `.git`
   folder, in a folder the target lacks is safe had no row; and a `.git` interior a check lists counted toward the
   person's own entry budget, so a refusal quoted a count they could not relate to (it now has a count of its own,
   and a refusal over it names that `.git`).
   Review round 6 (row 19, 18c): reset still replaced or deleted what no capture took wherever the target holds that path
   (trunk d5024f5a did the same, ok:true): the person's newer, ignored .env under the target's old one (E2), an ignored
   build/ folder and its key where the target holds a FILE `build` (E3), an ignored `logs` file where it holds logs/ (E4),
   a clone where it holds a FILE `vendor`, its .git and uncommitted work with it (E5), a clone's own edited file where it
   holds that file, and a plain `.git` folder (18c, which pinned that deletion as success). Each is now refused before
   anything is touched ('uncaptured_in_path', the path named). And with no clean left, a file reset could not unlink (held
   open by another program: Git warns, exits 0) made the rewind report ok:true; it is git_failed again, the file named
   (test/checkpoint-store.test.js row 4b).
   Review 6.2 (row 19, the w6 block): the check counted a folder as a repository only by the walk's looksLikeRepo,
   which is stricter than Git's own rule, so a LINKED WORKTREE (a commondir git-dir) and a folder whose `.git` is a link
   to a repository, both one gitlink to `add -A`, were plain folders to it: reset wrote the target's file over a
   worktree's uncommitted edit, deleted a worktree's folder for a target FILE, and overwrote an edit beside a `.git` link,
   ok:true each time (9b8c79a2 and trunk d5024f5a did the same). Every folder holding a `.git` of any kind that the shadow
   index tracks no path below now counts. And the rewind's two whole-change listings no longer depend on one call under
   the runner's output limit (test/checkpoint-store.test.js row 4c).
   Review minors (all rounds; rows 1, 4, 8b, 10, 11, 18, 19): an agent's FIRST snapshot recorded two rows for one commit
   (the git-log rebuild's lossy one first, the new row its own parent); a dangling mount point (libuv's lstat follows a
   reparse point it cannot read as a link, so ENOENT) was 'gone', neither left out nor refused (the lane's own
   classifier, round 1); row 4's "next capture" row says what it rests on; section 10's SSH lock reads environment.js
   alone; row 11's build/ and proj/ halves have a work tree each, so the embedded repository's capture failure before
   round 2 no longer hides the build/ deletion the label names; row 18a pins which way the undo goes; row 18's budget
   block pins the on-demand listing of a pruned folder past the person's own count (link_check_failed); a
   macOS `.GIT` (case folded, as Git reads it there) never counted as a `.git` (the w7 block emulates macOS on NTFS,
   which folds the same way); nor did one on Linux over a case-insensitive mount (WSL's /mnt/c, ext4 casefold,
   vfat/exFAT), where a clone, a linked worktree or a link spelled .GIT is one gitlink to Git too (w7d-w7f; it counts
   on every platform now: on a case-sensitive volume Git refuses to add any `.GIT` path, add exits 128); a `.GIT` folder
   or non-gitfile `.GIT` in a captured folder the target holds as a FILE is named only by the walk's gitFolders and
   gitFiles, which no row reached (w7b, w7c); and test/checkpoint-store.test.js row 4d pins the fail-closed answers of the round 6
   checks (uncaptured_check_failed; a listing failure after the reset is git_failed, the undo row recorded). And what
   reset will remove was listed only after it ran: a rewind past a flat folder whose own entry list passes the runner's
   output limit deleted it, answered git_failed, and every restore of its undo row was refused, as that rewind's own
   write list overflowed the same way (the folder then lived only in the shadow repo; introduced by round 6's two
   listings, narrowed to that folder by review 6.2's). It is now listed before the pre-restore commit, and that rewind
   is refused untouched (store row 4c).
   Final review 2 (row 20, test/checkpoint-undo-closure.test.js since undo review 12; store row 4c, test/checkpoint-store-capped.test.js): a COMPLETED rewind whose returned preRestoreId the normal API then refused,
   three ways, each introduced by this lane: (1) by round 1's link check, (2) by round 6's uncaptured check, (3) by round
   5's rewind without a clean (trunk d5024f5a's clean deleted that node_modules for good, and its undo then ran).
   (1) The link check listed a folder the target's .gitignore prunes in one ls-files call: past the
   runner's output limit, the undo of a rewind that deleted 120 captured files there was refused (link_check_failed),
   and every capture was skipped while the index tracked such a folder. (2) The undo of a rewind that turned a captured
   FILE into the target's big folder listed that folder's gitlinks in one ls-files -s call (uncaptured_check_failed).
   (3) A rewind to a point before the .gitignore that pruned a never-captured node_modules left it in place, unpruned:
   its undo walked it, past the walk's budget refused (link_check_failed), within it captured it whole and deleted it.
   Every whole-folder listing now splits (listUnder, gitlinksAtOrBelow), and a rewind's walk and capture go by the
   target's own .gitignore too, leaving out a folder only that prunes; each row runs restoreDetailed(preRestoreId) and
   compares every path and byte.
   Undo closure (row 20, fr2-fr6, test/checkpoint-undo-closure.test.js; the r3 review and Codex A4-2D1-01/02): a completed rewind's preRestoreId was still
   refused, or its undo deleted what no capture took, four ways, each from final review 2's target rules. A folder only
   the target's .gitignore lists, where the target held a path, was walked and captured whole: (fr3, fr3b) the rewind
   never listed it, and its undo, pruning it by the rewound .gitignore, listed it whole, past the limit for a flat
   folder (link_check_failed); (fr4) the undo of a rewind that had kept a node_modules' untracked files out, its row
   tracking files there, walked it (past the budget refused) and took them and deleted them. Every such folder is kept
   out now, a file there the rewind writes over or deletes taken by name (fr2), and the undo's own listing below the
   pruned folders is taken on the staged tree before the pre-restore commit, so a rewind that would leave it to an
   impossible listing is refused untouched (fr3c). (fr5) Past 32 changed .gitignore files the target's rules were
   dropped and the undo walked node_modules: every one is read now (git grep), and a rewind Git cannot read them for is
   refused. (fr6) Whether the target held a path there was asked case by case, so a case-only spelling refused it.
   Undo review 1 (test/checkpoint-undo.test.js, its header names each shape): the undo's read of its row's .gitignore
   files passed the runner's limit in one grep call (G1) or skipped one Git takes for binary (G2, G3: -I); its listing
   below a folder it prunes split down through a flat folder above it (R2, Ra, P1, P2); a folder its row's rule names
   beside a double-star bracket negation, or in another case, was walked and emptied (N, K); and a folder of files no
   capture took was deleted where the target holds a FILE and the index still did (P3, P3b: `ls-files --directory`
   printed nothing for it). And a rewind to a point an older store recorded with more files than the walk allows
   completed, its undo's walk over budget (W). Every .gitignore is read as text, a batch past the limit in halves, a
   file by its bytes; what the undo will read, list and walk is taken before the rewind's commit (its write list, its
   row's .gitignore texts, below every link, pruned folder and embedded repository its walk will find, the folders the
   reset makes among them, and its walk's count and depth); a listing never reads a folder above what it lists; a
   negation matches what it can match, a rule in another case keeps its folder out; and such a folder is listed file by
   file, what only the target's rules ignore there taken by name.
   Undo review 2 (test/checkpoint-undo.test.js, U J Y Ks2 Q E; this file's rows 12, 18 and 20): one family kept coming
   back, the walk's reading of what Git ignores, links or nests differing from Git's own. It is closed by REFUSAL, not by
   reading Git more closely: Git itself says which folders a plain rule prunes (a negation in a `.GITIGNORE`, or one
   holding a NUL, re-included a node_modules the walk pruned, and the rewind read and deleted through a junction there:
   J1 J2); a rewind that changes a .gitignore rule beyond one plain name, or changes any rule beside a negation or a NUL,
   is refused (row 12's allowlist, row 18's *.log, checkpoint-undo Q, P3, G2); one that would write or delete below an
   embedded repository is refused (a clone the index held as a gitlink, its working files deleted by the undo: Y; row
   18's v2); the undo's count of the tree its reset leaves is exact (it kept the folders that reset empties, and refused
   the undo of a completed rewind: U); every spelling of .gitignore is read (J3); and a file only the target's plain
   rule names is kept out like such a folder (E, row 18a: the old first DEFERRED bullet).
   Undo review 3 (test/checkpoint-undo.test.js Y4-Y6, N1): the same family through embedded repositories, each a
   completed rewind whose preRestoreId the API refused (2d1c2fb9: the undo deleted a clone's files, or was refused too).
   A write into a folder the reset makes inside a clone (Y/sub/a.txt, no sub/ in the clone) was never checked: written,
   and the undo read the clone as a plain folder (Y4). A gitlink the reset dropped over a vendored clone (its .git
   deleted) left a plain folder the undo took and would have deleted (Y5); over a linked worktree or a `.git` junction,
   which only the index named a repository, the undo's walk went in whole, past its rewind's count (Y6); and the
   question which folders are repositories answered "none" when its listing passed the runner's limit (N1). Every write
   is checked whatever folders the reset makes, a gitlink a rewind adds or drops at a folder of files is refused unless
   the folder holds a `.git` the walk reads as a repository, and a cut-off answer is asked again in halves, down to one
   folder, never read as "none".
   Undo review 4 (test/checkpoint-undo-gitlinks.test.js GF, H4, N2): a completed rewind whose undo the API refused on
   every try. The target recorded a gitlink where a FILE stands now, or below a folder the reset makes over one: Git
   wrote it as an empty folder, which the undo's check of what it deletes counted as an embedded repository (GF). A
   folder the undo prunes, below one the reset made over a FILE, is listed in full by its link check from that folder,
   and a gitlink's own empty folder, one level below its parent, is entered by its walk: the rewind's depth check
   measured neither (H4). Such a rewind is refused now, the depth measured as the undo measures it; N2 pins the asking
   again of N1 with a gitlink the target's index lists after the cut.
   Undo review 5 (test/checkpoint-undo-gitlinks.test.js SYM, gf1c, h4ac): a restore point that a capture older than the
   lane recorded with a symbolic link (trunk d5024f5a's `add -A` takes one): where Git makes links (POSIX) the rewind
   made it, and the undo's link check took it for a link of the person's own and refused on every try (from round 1's
   link check; trunk d5024f5a, with none, undid it). A rewind to or from a tree that records a symbolic link is refused
   now: whether Git writes the record as a link, and whether a capture keeps it for a plain file, turn on core.symlinks,
   which can change between a rewind and its undo. And no row pinned the case fold of a folder the reset makes over a
   FILE: GF and H4 with the FILE spelled V or Gen.
   Undo review 6 (test/checkpoint-undo-gitlinks.test.js IF1s, IF2, IF6, IF7): a completed rewind deleted, or wrote
   over, a FILE no capture took, and its undo was ok:true without it, where the shadow index still tracked paths below
   the FILE's name (a folder at the last capture): Git's index-aware check-ignore names nothing the index tracks a path
   below, so the uncaptured check neither refused nor took it. The person's ignored FILE logs, the index tracking
   logs/a.txt from a capture before their rule (IF1s, IF2: row 19's E4 shape; trunk d5024f5a the same), and a FILE no
   rule of the work tree ignores that only the target's rule names, or a folder above it (IF6: logs; IF7: dist/sub
   below dist), left out of the capture by its info/exclude line (introduced by the undo closure's keptOut, 8808d408,
   and undo review 2's keptFile, c8e20497). Git's rules alone are asked now (check-ignore --no-index): IF1s and IF2 are
   refused untouched, IF6 and IF7 take the FILE by name and both calls bring every path and byte back.
   Undo reviews 7-12 (test/checkpoint-undo-reads.test.js, split from checkpoint-undo-gitlinks at undo review 9, and test/checkpoint-undo-older.test.js, its undo
   review 8 rows split from it at undo review 12; test/checkpoint-undo-case.test.js, the rows of undo reviews 9-11, split from it at undo review 11;
   test/checkpoint-undo-folders.test.js and test/checkpoint-undo-held.test.js, undo review 11's rows split from that at undo review 12, the latter with undo
   review 12's own; their headers name each shape): names spelled apart in
   a letter outside A-Z, by Git's fold, the file system's or the walk's alone, Windows short names, the bytes a .gitattributes or the person's Git config changed, a row an
   older store wrote through the pin that stopped them, a .gitmodules `ignore = all`, hooks (a hook named "" among them), a Git whose exit code 1 was no answer of its own:
   a launch that failed, or a kill from outside; and a folder that reads case apart (WSL's, or one fsutil marked), where Git reads two names in A-Z case apart as one
   and a .gitignore only by its exact name: a `.GITIGNORE` the walk read as Git's kept the person's untracked file out of the rewind's capture and its undo deleted it,
   a file beside its twin was in no row, and a capture stored a file at its twin's length; then a folder no name could ask whether it reads so, which a folder the reset
   made there took the case of, eight pairs of twins at the top of a clone that hid the person's pair from the checks, and a folder respelled since the last capture;
   then what Git leaves: a folder it could not remove (another program's working folder, a read-only folder), a file another program holds open, a reset stopped
   partway, an empty folder no capture records, and a name the disk spells otherwise than every capture; then a twin a refused rewind's capture staged for the
   next capture to commit, a listing split on one tree where its undo splits it on the other, a program running from the workspace, and a held file the reset
   wrote over or deleted, its undo refused on every try.
   THE PROMISE these rows pin: a rewind is refused before anything is touched, with no undo row and every path and byte
   where it was, or it completes and restoreDetailed(its preRestoreId) brings every path and byte back. It goes ahead
   while the .gitignore rules it changes are plain names (node_modules, dist/, /build) and none beside them holds a
   negation or a NUL, in any spelling of .gitignore; the rules it does not change can be anything (checkpoint-undo nu).
   It writes and deletes nothing below an embedded repository, adds or drops a gitlink only at a folder that is empty,
   not there, or a clone the walk reads as one (checkpoint-undo y5c), and then only in a folder it neither makes nor removes
   and that holds besides it a name with a letter A-Z (checkpoint-undo-case eg0 goes ahead; eg1, egr, eg2, eg3, csge, csgd, mg, sro3 are refused), records none
   where a FILE stands, at that path or above it (checkpoint-undo-gitlinks GF), and runs only between trees that record no symbolic link
   (checkpoint-undo-gitlinks SYM). It replaces or deletes no file no capture took, whatever the shadow index still
   tracks below its name: one a rule of the work tree ignores refuses it (row 19; checkpoint-undo-gitlinks IF1s, IF2),
   one only the target's rules name is taken by name (checkpoint-undo-closure fr2; checkpoint-undo P3 plain; checkpoint-undo-gitlinks
   IF6, IF7). Its bytes are the person's whatever a .gitattributes or the person's Git config asks (checkpoint-undo-reads
   at1-at7, atold, g2, gis, gfm, ghk, gat, gfl; checkpoint-undo-older atnc, ghc, ghv, ghd, ghe, ghi), and it goes to a row an older store wrote only where no conversion could have
   changed what that stored (checkpoint-undo-older old1-old6, oldat, olddisk, oldpr, oldsys, oldxdg). It reads a gitlink whatever a .gitmodules marks (m1, m3, m4), it runs
   only where Git, the file system and its own fold read every name in play alike (uw, ud, ur, uu, uboth; checkpoint-undo-older sg3-sg7, ova, ovg, ovt, ovk, ovkb-ovkf; checkpoint-undo-reads snw, snf, snr, snc; from here
   checkpoint-undo-case's, checkpoint-undo-folders' and checkpoint-undo-held's rows): no folder its checks list reads case apart, except one its reset empties, each entry
   spelled as it stands at every component, none of them in use, nor an empty folder in it (nest1, ex1, hca, hcd, x3, e1); no
   folder no name can ask whether it does (one that holds nothing, or only names with no letter A-Z) changes, except one its reset empties, holding such a name alone (rp3), or an
   empty one its undo empties as it was written, below a folder that holds besides it, and besides every other such folder, a name with a letter A-Z; nor is the root left holding
   nothing where a gitlink is dropped (csd5, csdf, csgc, csge, csep, csx, csre, ef1, efn, ie2, ie3, c1, k1; cse, csm, ef0, ie2c go ahead); no folder that holds something on both sides of
   its reset holds a name with a letter A-Z on one side only, a gitlink's empty folder counted (cs5, csa, csb, cs2, csl, csl2, csw, csgd, n1; cs6, csn, csr go ahead; two names
   in A-Z case apart refuse every capture before its `add`, a rewind's too, so none stores or stages a file at its twin's length, wherever they stand but inside an embedded
   repository or a `.git` folder: cap8, capb, tws, twe); no folder it must remove, the root it leaves holding nothing among them, or makes for its undo to remove, holds a name with
   no letter A-Z beside another (hp1, hp2, hp6, csz, rp1, rp2, mp, mp2, r0; rp4 goes ahead); every path it deletes, writes or writes over is spelled as the disk spells it, but a
   file it deletes first and a folder of files where it writes a FILE, and no two of them spell one name two ways (sro2, fn1-fn4, ms, tw1, tw2, checkpoint-undo Ks, checkpoint-undo-closure fr6;
   csr, checkpoint-undo-gitlinks h4acs go ahead); and it asks, as late as its checks go, that Git can remove what it would stop at, and every file it deletes or writes over,
   a program running from one too (st1-st4, x1-x4, hw1, hg1, hg2, hl1, hl2; xro, a read-only file no program runs, goes ahead), so a rewind Git only warned about is one a
   program opened a file for after the checks, which answers git_failed with an undo row that restores every path and byte (hpc, hp7, hp8, the hold taken just before the
   reset), and a folder Git left standing is written into again (sro1). What its undo will list of what the reset writes over is split under the runner's output limit on
   both trees, as the rewind and its undo each split it (rw1, rw2; rw3 goes ahead). It takes an exit code 1 for an answer only with the rest of that answer (kl1-kl5, klc, klu,
   klf, atnk, oldk, lf1-lf3).
   DEFERRED (each a follow-up, none loosens what a rewind keeps):
     - a rewind that changes a glob or path rule, or any rule beside a negation, is refused (above), though many such
       rewinds would round-trip: keeping those in place both ways needs the target's full ignore rules evaluated by Git
       before the reset;
     - a rewind that adds or drops a gitlink at a folder holding files and no `.git` the walk reads as a repository is
       refused (above), though a linked worktree's, a `.git` link's or an ignored folder's would often round-trip: telling
       them apart needs Git's own repository rule (is_nonbare_repository_dir) asked for both sides before the reset.
       So is one that records a gitlink where a FILE stands, at that path or above it, though its undo could often
       delete the empty folder Git makes there (trunk d5024f5a's did): that needs the undo's check to tell such a folder
       from a repository the same way;
     - a rewind to or from a tree that records a symbolic link (a capture older than the lane took one; where Git writes
       a link as a plain file, the shadow index keeps the record for the plain file there) is refused on every platform,
       though many would round-trip: where Git writes links as plain files (core.symlinks false, Windows' usual), or where
       the record is the same on both sides. Telling them apart needs the effective core.symlinks of both calls, which a
       person can change between them;
     - a rewind to or from a tree that records a component of a Windows short name's shape (up to 8 characters ending in ~ and
       digits, then at most a 3-character extension) is refused on Windows, a literal file or folder of that name too,
       though it would round-trip while nothing else takes that short name. Telling them apart needs what NTFS will
       generate for every long name the reset writes, on both calls (checkpoint-undo-reads snr: the undo row's literal name, the
       target's long name);
     - a rewind where a tree or the work tree spells a name apart in a letter outside A-Z (Git reads two names, and the file system one, or the walk's fold alone one: the
       Angstrom sign and a-ring, final and small sigma, which NTFS keeps apart) is refused, a case-only rename of such a name that would round-trip too, and every rewind from a capture of a folder
       so renamed, until that folder is moved aside (the next capture then drops both spellings). So is a rewind with the Kelvin sign in a name, in either tree or in a folder its checks
       list, whatever stands there and though many would round-trip: the fold reads it as k, and no list of the names outside A-Z holds its twin (checkpoint-undo-older ovk,
       ovkb-ovkf). Modelling it needs each lookup by Git's fold asked by the file system's; the walk's fold is what a sweep of NTFS found (the store's THE FOLD), and macOS's
       normalization is asked of the file system only at a name outside ASCII no listing shows (uafs, an injected lstat: no row has run on macOS). Listing the names outside A-Z, and on Windows of that short-name shape, is Git's own glob over
       both trees: past the runner's output limit (their names alone, about 100k paths at 8 MB) the rewind is refused and
       a capture with a link in such a name is skipped (checkpoint-undo-reads ucap1-ucap3);
     - a rewind where a folder its checks list reads case apart is refused unless its reset deletes every entry there, each spelled as it stands at every
       component of its path (nest1, ex1: a folder or a file respelled since the last capture), and writes nothing at or below it (Git then removes it, and
       makes it again, as its parent reads, if the undo writes there), though many would round-trip: every rewind in a tree WSL made, beside one folder WSL or
       fsutil marked anywhere its checks list (csw), on a case-sensitive volume where the store folds case (a case-sensitive APFS: every folder there reads
       case apart; no row has run on macOS), and one that empties such a folder and writes into it. A folder no name can ask whether it does, one that holds
       nothing or only names with no letter A-Z, refuses a rewind that adds, deletes or replaces a name in it (csd5), unless the reset removes it, it holding
       one such name alone (hp7, hp8, rp3), or writes into an empty one that its undo empties as written: no gitlink there, and the folder above it holding besides it, and besides every other such
       folder, a name with a letter A-Z, or nothing else, up to one that does or the root (cse, csm, ef0, ie2c go ahead; csge, csep, ef1, ie2, c1, k1 are
       refused), the target's records below it listed in one go, so past the runner's output limit (about a million at 8 MB) that rewind is refused
       (csgu, csgv; the staged tree's below a folder that must go, or all of it where the root is left holding nothing: csgb, csgs, csgr). So, on Windows and macOS, a rewind that adds a name to a folder like 2024/ that holds only numbered names, or takes one from it, replaces a
       folder there with a FILE or drops a clone's gitlink there (csdf, csgc), writes into an empty folder below one that holds only such names, writes or records
       a gitlink or a FILE where a folder that holds no file stands below one (eg1, egr, eg2, ef1, efn), or writes a
       gitlink into an empty folder, is refused though most would round-trip; so is one that writes a name with a letter A-Z into a folder that holds only
       names with none, or leaves one so (csl, csl2, and csgd: a gitlink's empty folder Git removes beside 1; no name there can ask the folder, and its undo
       would ask it on the other side), and one that leaves the root holding nothing and drops a gitlink (csre). A rewind that removes a folder holding a
       name with no letter A-Z beside another (logs/ holding app.log and 2026, 2024/ holding 01 and 02: hp1, hp2, hp6, csz, rp1, rp2), or makes one (mp, mp2: its
       undo would have to remove it, and no rule gives way for an undo), or removes or makes a folder holding a gitlink (sro3, mg, eg3), is refused though most
       would round-trip: Git leaves a file another program holds open and a folder that is another program's working folder or read-only (Git for Windows'
       rmdir clears no attribute), so such a folder could stand holding part of what it held, which its undo could not ask. A rewind is refused where a tree spells a
       path it deletes, writes or writes over otherwise than the disk, at any component that stands (a folder or file renamed in another case: Git keeps the spelling
       a path first had, so every capture since does too): every rewind that touches such a name, until it is renamed back, or moved aside past a capture
       (fn1-fn4, sro2, ms, Ks, fr6), though most would round-trip, the bytes back under the old spelling. Telling a rename the undo would keep from one it
       would lose needs Git's own reset modelled, which is what the steering of undo review 10 ruled out. A folder that reads case apart which the reset empties, a
       folder where it writes a FILE, a FILE it makes a folder of, and every file it deletes or writes over are asked of the file system as late as the checks go,
       Windows' alone (the store's inUse: a file another program holds open or runs as its own image, a read-only program file, which no open for writing can ask,
       its working folder, a read-only folder): in use, the rewind is refused until that lets go (hca, hcd, st1-st4, x1-x4, hw1, hg1, hg2, hl1, hl2, hpc, hp7, hp8),
       though a file held with delete sharing would have gone, and so would a read-only program file no program runs. Not seen: a program that opens one of them
       between that check and the reset, one that maps a file as data and closes its handle (no open asks that), and a file whose permissions let it be
       written but not deleted (no row has run either); and Git killed from outside, or past the runner's 15 s, in its reset stops partway too: the rewind answers
       git_failed with its undo row, every byte in it, and that undo can be refused as any rewind is, naming the folder or the file, until it is moved aside (where
       Git only warned of a file it left, that undo restores every path and byte where the checks above let the rewind go: hpc, hp7, hp8, the hold taken just before
       the reset). Closing that moment needs a reset the store runs itself, path by path. An embedded repository and a `.git` folder are not asked: Git reads
       neither, and a rewind writes into neither (csn). Telling them apart needs the folder's own flag (FileCaseSensitiveInformation, which no Node API reads), or
       Git's own reading of each such folder, on both calls; every capture is refused before its `add` while two names in A-Z case apart stand side by side anywhere
       but inside an embedded repository or a `.git` folder, as Git takes only one of them, at the other's length (a snapshot is skipped, health says so: csa, csb,
       cap8, capb; a rewind is refused, its capture's `add` never run, so nothing stages them: tws, twe);
     - a rewind to a row an older store wrote (a commit without the store's mark, STORED_AS_IT_IS) is refused where a conversion could have changed what it stored: a
       .gitattributes it holds, or one standing in a folder the checks list, with a line naming text, eol, crlf, ident, filter or working-tree-encoding; core.attributesFile set; such a
       line in the file Git reads when that is not set, or in the system's own, which a Git older than 2.42 cannot say the place of, so that one is not asked. A project with
       `* text=auto` keeps its older rows in the list, unrewindable, until they age out (up to 50 an agent), though many hold bytes no rule changed and would round-trip; every
       row taken since goes ahead. Telling them apart needs the bytes those rows were taken from, which no store kept. A rule gone from the row and the disk alike is not seen:
       such a row is written as stored, as any store would write it then;
     - the person's global Git config is pinned where it reached the person's files or hid them (the store's pinnedConfig, each hook it names switched off by name, the
       empty name too: ghe), not
       as a whole: commit.gpgSign or a diff.orderFile that cannot run still makes every capture fail, and health says so, as on
       trunk d5024f5a. A hook whose name holds '=', which -c cannot say, stops every capture and rewind while it stands (gheq, health says so);
     - A GIT KILLED FROM OUTSIDE WITH EXIT CODE 0 LOSES A FILE, IN A WINDOW OF MILLISECONDS. WMI's Terminate (Invoke-CimMethod) ends a process with the code it is
       given, 0 by default, and no runner can tell that from a Git that finished: an empty answer to the rewind's write list then passes its checks, and the reset writes over an
       ignored file no row holds, ok:true on both calls (trunk d5024f5a lost that file with no kill at all). taskkill /F and process.kill give 1, Stop-Process 4294967295, each no answer now. Closing it needs Git's own word
       that each call ran to its end (GIT_TRACE2_EVENT's exit event, on every call);
     - an untracked embedded repository with no commit yet still makes every capture fail (Git's add exits 128), as on
       trunk d5024f5a; health says so. Leaving it out of `add` needs a new excluded class at the capture boundary;
     - a flat folder whose own entry list (ls-tree, names only) passes the runner's output limit, about 150k-250k long
       names at 8 MB. STORED: every captured file of it is in the shadow repo, which alone proves nothing. API-RESTORABLE:
       a restore point holding it restores through restoreDetailed whenever that rewind need not list the folder whole
       (it writes or removes few of its files, and no .gitignore of either side prunes a folder above it), on a Git of
       2.36 or newer and below about a million records in either tree. Otherwise REFUSED BEFORE ANYTHING IS TOUCHED, with
       no undo row: a rewind that brings back, removes or, on Windows and macOS, writes over so many of its files that their names alone pass the limit
       (uncaptured_check_failed: csgm), or must check them for links below a pruned folder (link_check_failed); store row 4c,
       the cf and cv blocks; and any rewind to or from a tree holding it past that Git or those records, whose link-record
       listing then reads every folder's entry list (the store's linkRecords). A capture is skipped while the index tracks it
       below a pruned folder (health says so). What a completed rewind's undo will list is taken before the rewind's
       commit, on its staged tree: its write list (the rewind's removals), its row's changed .gitignore texts, and what
       the target and its row hold below every link, pruned folder and embedded repository its walk will find, the
       folders the reset makes that a plain rule prunes among them (checkpoint-undo-closure fr3c; checkpoint-undo G1b), the count and
       depth of its walk, and the depth of what its link check lists in full (checkpoint-undo W, U;
       checkpoint-undo-gitlinks H4); its removals are the rewind's own writes; and no listing reads the entry list of a
       folder above what it lists (checkpoint-undo R2, Ra, P1, P2). So no listing an undo takes needs a folder entry list
       its rewind did not take, or the rewind is refused untouched. Such a rewind cannot run (splitting by name prefix is
       the follow-up);
     - wall time still bounds every restore, an undo too: the walk's 10 s deadline and the runner's 15 s per Git call
       depend on the machine, so an undo's add of a big folder can be refused (pre_restore_failed, untouched) on a slow
       machine; the person then moves that folder aside and undoes again. The first capture or rewind on a shadow repo an older store wrote hashes every
       tracked file once, under the 120 s maintenance bound; past it every capture is skipped and every rewind refused (pre_restore_failed, untouched, health says so), and each
       try starts that hash over, until a try finishes it (atbig, atbig2);
     - restore's checks cost Git calls: about 10 per 256 files that stand at a path the rewind writes (the uncaptured
       check, no deadline of its own), and replacedFolders asks every pruned folder and its ancestors even with no
       link; bounded, never a hang;
     - shell.bg.write now shares the per-turn precise checkpoint key, as terminal.write did on trunk: a second write in
       the same turn after an unchanged first one takes no new snapshot (the key lives in index.js's closure);
     - the links a capture left out reach no screen: the restore route's 200 body, checkpoint.created and the RESTORE
       lane do not show them, and frontend/app/windows/rewind.js still says a rewind removes anything created since
       (it keeps ignored files and links); a frontend follow-up.
   PRE-EXISTING (the lane did not worsen them; the rows here pin the fix): A, B, C', E, F above; P8 (trunk d5024f5a
   emptied the same folder, having also captured it), P8 inside an ignored folder or an embedded repository, through a
   `.git` junction and through a link inside a real `.git` folder (trunk d5024f5a emptied the same folders, rows 11, 16
   and 17), the P1 shape of the clean (trunk removed the same folder) and its .env shape (row 18); and the pre-admission
   snapshots test/checkpoint-admission.test.js covers; the shapes of the store's NOTHING NO CAPTURE TOOK of round 6 (row
   19: trunk replaced or deleted the same files), the linked-worktree and `.git`-link shapes of review 6.2 among them,
   and undo review 6's ignored FILE where the shadow index tracks paths below its name (checkpoint-undo-gitlinks IF1s,
   IF2: trunk deleted or wrote over the same file); and an agent's first snapshot recorded as two rows (row 1; fixed in
   b25a48d5). A folder the target holds as a FILE is
   still deleted with all it holds when every file in it is captured (in the undo row) and no link, repository or `.git`
   lies in it (the store's restore comment, WHAT A REWIND REMOVES); a link anywhere in it, inside its `.git` too, refuses
   the rewind (rows 16 and 17), and so does anything no capture took (row 19). A `.git` junction, or a link inside a
   plain `.git` folder, in a folder the target lacks stays where it is with that folder, and so does what it points at
   (row 18; a rewind that would delete a captured file in that folder is refused since undo review 2). Not covered here:
   the SSH tar engine
   (environment.js states its scope: links are archived as links; a mount inside the remote root is documented, not
   fixed). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { makeClock } = require('../shared/clock-rng.js');
const { makeCheckpointStore } = require('../sidecar/checkpoint-store.js');
const { makeCheckpointGitRunner } = require('../sidecar/checkpoint-git.js');
const { runGit, gitRun, launchSpawn, runRows } = require('./helpers/checkpoint-rows.js');
const { sidecarSourceFiles, locateSidecarFunction, sidecarFunctionSource, sidecarTopLevelFunction } = require('./helpers/source');

const isWin = process.platform === 'win32';

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-ckpt-links-')));
const ROOT = path.join(BASE, 'ws');
const links = [];
function link(target, at) {
  if (path.relative(BASE, target).startsWith('..')) throw new Error('fixture link target outside the test folder');
  fs.symlinkSync(target, at, isWin ? 'junction' : 'dir');
  links.push(at);
}
function unlinkLink(at) {
  if (!isWin) fs.unlinkSync(at);
  else {
    try { execFileSync('cmd', ['/c', 'rmdir', at], { windowsHide: true, stdio: 'ignore' }); }   // a junction / directory link
    catch (e) { if (isLink(at)) fs.unlinkSync(at); else throw e; }                              // a file symlink: unlinked, never followed
  }
  const i = links.indexOf(at); if (i >= 0) links.splice(i, 1);
}
function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; } }
// an embedded repository with one commit: its own .git in the fixture, never the shadow repo; its commit starts no
// background `git maintenance run --auto`, as none of the store's own commits does
async function gitInit(dir) {
  const id = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];
  await gitRun(['init', '-q'], { cwd: dir });
  await gitRun(id.concat(['add', '-A']), { cwd: dir });
  await gitRun(id.concat(['commit', '-q', '-m', 'c']), { cwd: dir });
}
function fsWith(over) {   // the real fs with some fs.promises calls replaced
  const promises = Object.assign(Object.create(fs.promises), over);
  const out = Object.create(fs);
  Object.defineProperty(out, 'promises', { value: promises });
  return out;
}
function put(file, body) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); }
// the same without holding up the other rows (the fixtures of a thousand folders and more)
async function putAsync(file, body) { await fs.promises.mkdir(path.dirname(file), { recursive: true }); await fs.promises.writeFile(file, body); }
function bodyOf(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } }   // null once a rewind deleted it
function outside(name, files) {
  const dir = path.join(BASE, name);
  for (const [rel, body] of Object.entries(files)) put(path.join(dir, rel), body);
  return dir;
}
function listing(dir) {   // every file below dir with its bytes, by path (a fixture's own outside folder: never a link inside)
  const out = {};
  const walk = (d, pre) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const rel = pre ? pre + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), rel); else out[rel] = fs.readFileSync(path.join(d, e.name), 'utf8'); } };
  walk(dir, '');
  return Object.fromEntries(Object.entries(out).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)));
}
const gitDirOf = (aid) => path.join(ROOT, '.checkpoints', aid, 'git');
async function tree(aid, sha) {
  return (await gitRun(['--git-dir', gitDirOf(aid), 'ls-tree', '-r', '-z', '--name-only', sha])).split('\0').filter(Boolean);
}
const rowOf = (store, aid, id) => store.list(aid).snapshots.find((s) => s.id === id) || null;
const linkPaths = (x) => ((x && x.links) || []).map((l) => l.path).sort();

(async () => {
  const clock = makeClock(1700000000000);
  const store = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50 });
  // each row owns its agent id, work tree and outside folders; the longest start first (the two with a thousand folders
  // or more, the three that rewind four or five work trees each, then b1, c1, r2, v3: three snapshots or more each, with
  // two rewinds; row 20's are test/checkpoint-undo-closure.test.js's since undo review 12), so no long row is left to run alone at the end
  const rows = [], first = [];
  const row = (name, fn, early) => { (early ? first : rows).push({ name: name, fn: fn }); };
  try {
    // ================= 1. CAPTURE (probe A): a link's target never enters a restore point =================
    row('a1', async () => {
      const aid = 'a1', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      put(path.join(wt, 'sub', 'deep', 'mine.txt'), 'mine\n');
      const outA = outside('outA', { 'secret.txt': 'OUTSIDE-A\n' });
      link(outA, path.join(wt, 'jx'));
      link(outA, path.join(wt, 'sub', 'deep', 'jdeep'));
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'with links' });
      A.ok(s1 && s1.created, 'a work tree holding links still saves a restore point');
      const t1 = s1 ? (await tree(aid, s1.id)) : [];
      A.eq(t1, ['own.txt', 'sub/deep/mine.txt'], 'the snapshot holds the work tree\'s own files and nothing from behind a link');
      A.eq(linkPaths(s1), ['jx', 'sub/deep/jdeep'], 'the result names every link it left out');
      A.eq(s1 && s1.linksTotal, 2, 'and counts them');
      A.eq(linkPaths(rowOf(store, aid, s1 && s1.id)), ['jx', 'sub/deep/jdeep'], 'the index row records the links too');
      // an agent's FIRST snapshot: with no index.json yet, the resilient load rebuilt the commit just made as a lossy row
      // (no runId, no links) that came first and became the new row's own parent (b25a48d5 fixed it)
      const firstRows = store.list(aid).snapshots.filter((s) => s.id === (s1 && s1.id));
      A.eq(firstRows.map((s) => [s.runId, s.parentId === s.id]), [['r', false]], 'an agent\'s first snapshot is one row, with its runId, not its own parent');
      A.ok(store.health(aid) && store.health(aid).ok === true, 'a restore point saved without its links is a working net (health ok)');
      A.eq(listing(outA), { 'secret.txt': 'OUTSIDE-A\n' }, 'the outside folder is untouched');
      // a FILE symlink and a DIRECTORY symlink (Windows needs the symlink privilege or Developer Mode; skipped without it)
      let symlinked = false;
      try {
        fs.symlinkSync(path.join(outA, 'secret.txt'), path.join(wt, 'fl'), 'file'); links.push(path.join(wt, 'fl'));
        fs.symlinkSync(outA, path.join(wt, 'dl'), 'dir'); links.push(path.join(wt, 'dl'));
        symlinked = true;
      } catch (e) { console.log('[skip] file/directory symlinks: ' + e.code); }
      if (symlinked) {
        const sl = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'symlinks too' });
        const tl = sl ? (await tree(aid, sl.id)) : [];
        A.ok(sl && !tl.some((p) => p === 'fl' || p === 'dl' || p.startsWith('dl/')), 'file and directory symlinks are left out like junctions (' + tl.join(',') + ')');
        A.ok(sl && ['dl', 'fl'].every((n) => linkPaths(sl).includes(n)), 'and recorded');
        for (const n of ['fl', 'dl']) { const p = path.join(wt, n); if (isWin && n === 'dl') execFileSync('cmd', ['/c', 'rmdir', p], { stdio: 'ignore' }); else fs.unlinkSync(p); links.splice(links.indexOf(p), 1); }
      }
      // a link that went away is captured again as the real folder it now is
      unlinkLink(path.join(wt, 'sub', 'deep', 'jdeep'));
      put(path.join(wt, 'sub', 'deep', 'jdeep', 'real.txt'), 'real now\n');
      const s1b = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'link replaced by a real folder' });
      A.ok(s1b && (await tree(aid, s1b.id)).includes('sub/deep/jdeep/real.txt'), 'a real folder where a link used to be is captured (the exclusion is rewritten every time)');
      A.eq(linkPaths(s1b), ['jx'], 'and only the remaining link is recorded');
      // a link that appears with nothing else changed is its own restore point, not a dedup onto a row that never named it
      const outA2 = outside('outA2', { 'y.txt': 'Y\n' });
      link(outA2, path.join(wt, 'jy'));
      const s1c = await store.snapshot(aid, { runId: 'r', turn: 3, label: 'only a new link' });
      A.ok(s1c && s1c.created && rowOf(store, aid, s1c.id) && linkPaths(rowOf(store, aid, s1c.id)).join() === 'jx,jy', 'a new link alone records a new row naming it');
      const s1d = await store.snapshot(aid, { runId: 'r', turn: 4, label: 'nothing changed' });
      A.ok(s1d && s1d.created === false && s1d.id === s1c.id, 'with the same links and the same files the snapshot still dedups');
    });

    // ================= 2. TRACKED DESCENDANTS (probe B) and a tracked LEAF (probe F) =================
    row('b1', async () => {
      const aidB = 'b1', wtB = path.join(ROOT, aidB);
      const outB = outside('outB', { 'a.txt': 'OUTSIDE-B-a\n', 'b.txt': 'OUTSIDE-B-b\n' });
      const outL = outside('outL', { 'x.txt': 'OUTSIDE-L\n' });
      let s2 = null, sLeaf = null;
      {
        put(path.join(wtB, 'keep.txt'), 'keep\n');
        put(path.join(wtB, 'd', 'a.txt'), 'inside-d-a\n');
        put(path.join(wtB, 'L'), 'L-body\n');
        s2 = await store.snapshot(aidB, { runId: 'r', turn: 1, label: 'real d and L' });
        A.eq(s2 ? (await tree(aidB, s2.id)) : [], ['L', 'd/a.txt', 'keep.txt'], 'fixture: d/a.txt and the file L are tracked');
        fs.rmSync(path.join(wtB, 'd'), { recursive: true });
        link(outB, path.join(wtB, 'd'));
        const s3 = await store.snapshot(aidB, { runId: 'r', turn: 2, label: 'd is now a junction' });
        A.ok(s3 && s3.created, 'the next snapshot is saved');
        const t3 = s3 ? (await tree(aidB, s3.id)) : [];
        A.ok(!t3.some((p) => p === 'd' || p.startsWith('d/')), 'a tracked folder swapped for a link is dropped, never re-read through it (' + t3.join(',') + ')');
        A.eq(linkPaths(s3), ['d'], 'and the link is recorded');
        fs.unlinkSync(path.join(wtB, 'L'));
        link(outL, path.join(wtB, 'L'));
        sLeaf = await store.snapshot(aidB, { runId: 'r', turn: 3, label: 'L is now a junction' });
        const tL = sLeaf ? (await tree(aidB, sLeaf.id)) : [];
        A.eq(tL, ['keep.txt'], 'a tracked FILE swapped for a link is dropped too; nothing of its target is read');
        A.eq(listing(outB), { 'a.txt': 'OUTSIDE-B-a\n', 'b.txt': 'OUTSIDE-B-b\n' }, 'outB untouched by the captures');
      }

      // ================= 3. RESTORE refuses to write or delete through a link (probes C', F) =================
      {
        const rowsBefore = store.list(aidB).snapshots.length;
        const r = await store.restoreDetailed(aidB, s2.id);   // s2 holds d/a.txt and the file L; both are links now
        A.eq(r && r.ok, false, 'a rewind whose files sit behind a link is refused');
        A.eq(r && r.reason, 'link_in_path', 'with its own reason');
        A.ok(r && /"(d|L)" is a link/.test(r.detail || '') && /Nothing was changed/.test(r.detail || ''), 'the refusal names the link and says nothing changed (' + (r && r.detail) + ')');
        A.ok(r && Array.isArray(r.links) && r.links.some((h) => h.link === 'd' && h.path === 'd/a.txt') && r.links.some((h) => h.link === 'L' && h.path === 'L'), 'both the folder case and the leaf case are named');
        A.eq(store.list(aidB).snapshots.length, rowsBefore, 'a refused rewind wrote no pre-restore row: nothing was touched');
        A.eq(listing(outB), { 'a.txt': 'OUTSIDE-B-a\n', 'b.txt': 'OUTSIDE-B-b\n' }, 'outB is untouched (C\': b.txt used to be deleted through the junction)');
        A.eq(listing(outL), { 'x.txt': 'OUTSIDE-L\n' }, 'outL is untouched (F: x.txt used to be deleted through the junction)');
        A.ok(isLink(path.join(wtB, 'd')) && isLink(path.join(wtB, 'L')), 'and both links are still where they were');
        // the same work tree, rewound to a point that never had d/ or L: the links stay put and nothing behind them moves
        const rOk = await store.restoreDetailed(aidB, sLeaf.id);
        A.eq(rOk && rOk.ok, true, 'a rewind that passes through no link goes ahead (' + JSON.stringify(rOk) + ')');
        A.eq(linkPaths(rOk), ['L', 'd'], 'and says which links it left where they were');
        A.ok(isLink(path.join(wtB, 'd')) && isLink(path.join(wtB, 'L')), 'the rewind neither removed nor entered a link');
        A.eq(listing(outB), { 'a.txt': 'OUTSIDE-B-a\n', 'b.txt': 'OUTSIDE-B-b\n' }, 'outB still whole after a completed rewind');
        A.eq(listing(outL), { 'x.txt': 'OUTSIDE-L\n' }, 'outL still whole after a completed rewind');
      }
    }, true);

    // ================= 4. THE NPM-LINK REWIND (probe E), plain and under a .gitignore'd node_modules =================
    row('e1', async () => {
      const aid = 'e1', wt = path.join(ROOT, aid);
      const lib = outside('mylib', { 'index.js': 'module.exports = 1;\n', 'src/core.js': 'core\n' });
      const libBefore = listing(lib);
      put(path.join(wt, 'package.json'), '{}\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'before npm link' });
      fs.mkdirSync(path.join(wt, 'node_modules'));
      link(lib, path.join(wt, 'node_modules', 'mylib'));
      // a shadow index a pre-fix capture left: `add -A` walked the junction (exactly what trunk d5024f5a did)
      fs.writeFileSync(path.join(gitDirOf(aid), 'info', 'exclude'), '');
      await gitRun(['--git-dir', gitDirOf(aid), '--work-tree', wt, '-c', 'core.autocrlf=false', 'add', '-A'], { cwd: wt });
      const legacy = await gitRun(['--git-dir', gitDirOf(aid), 'ls-files']);
      // a junction is a folder to Git, so `add -A` walked it; POSIX Git records a symlink as the link itself and never walks it
      A.ok((isWin ? /node_modules\/mylib\/index\.js/ : /^node_modules\/mylib$/m).test(legacy), 'fixture: the shadow index tracks ' + (isWin ? 'files behind the junction, as a pre-fix capture left it' : 'the link itself, all POSIX Git ever records'));
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.reason, 'link_in_path', 'rewinding while the index tracks files behind the junction is refused (they would be deleted through it)');
      A.ok(r && /"node_modules\/mylib" is a link/.test(r.detail || ''), 'naming the link (' + (r && r.detail) + ')');
      A.eq(listing(lib), libBefore, 'the linked library outside the workspace is whole');
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'after npm link' });
      // this rests on the refusal above: on trunk d5024f5a that rewind had already deleted the files behind the link, so
      // the next capture found nothing there to drop (section 2 pins the same drop on a fixture no rewind touched)
      A.ok(s1 && !(await tree(aid, s1.id)).some((p) => p.startsWith('node_modules/')), 'the next capture drops what the old index tracked behind the link, the files still there behind it');
      A.eq(linkPaths(s1), ['node_modules/mylib'], 'and records the link');
      const r2 = await store.restoreDetailed(aid, s0.id);
      A.eq(r2 && r2.ok, true, 'the rewind to before `npm link` then goes ahead');
      A.ok(isLink(path.join(wt, 'node_modules', 'mylib')), 'the link itself is left in place (it was never captured, so removing it could not be undone)');
      A.eq(listing(lib), libBefore, 'and ../mylib keeps index.js and src/core.js');
    });
    row('e2', async () => {
      // a tracked file below a folder .gitignore now excludes: the walk prunes the folder, the boundary still checks it
      const aid = 'e2', wt = path.join(ROOT, aid);
      const lib2 = outside('mylib2', { 'index.js': 'OUTSIDE-LIB2\n' });
      put(path.join(wt, 'package.json'), '{}\n');
      put(path.join(wt, 'node_modules', 'mylib', 'index.js'), 'tracked before the ignore rule\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'node_modules tracked' });
      A.ok(s0 && (await tree(aid, s0.id)).includes('node_modules/mylib/index.js'), 'fixture: node_modules/mylib/index.js is tracked');
      put(path.join(wt, '.gitignore'), 'node_modules/\n');
      fs.rmSync(path.join(wt, 'node_modules', 'mylib'), { recursive: true });
      link(lib2, path.join(wt, 'node_modules', 'mylib'));
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'mylib is a junction under an ignored folder' });
      const t1 = s1 ? (await tree(aid, s1.id)) : [];
      A.ok(s1 && !t1.some((p) => p.startsWith('node_modules/')), 'a tracked file under an ignored folder is not re-read through a junction (' + t1.join(',') + ')');
      A.eq(linkPaths(s1), ['node_modules/mylib'], 'the link found below the pruned folder is recorded');
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.reason, 'link_in_path', 'rewinding to the point that tracked node_modules/mylib/index.js is refused');
      A.eq(listing(lib2), { 'index.js': 'OUTSIDE-LIB2\n' }, 'the outside library is not overwritten');
    });

    // ================= 5. a .gitignore NEGATION cannot re-include a link =================
    row('n1', async () => {
      const aid = 'n1', wt = path.join(ROOT, aid);
      const outN = outside('outN', { 'n.txt': 'OUTSIDE-N\n' });
      put(path.join(wt, '.gitignore'), '*\n!*/\n!*.txt\n!.gitignore\n');   // an allowlist .gitignore re-includes every folder
      put(path.join(wt, 'own.txt'), 'own\n');
      link(outN, path.join(wt, 'jn'));
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'allowlist ignore' });
      const t1 = s1 ? (await tree(aid, s1.id)) : [];
      A.eq(t1, ['.gitignore', 'own.txt'], 'the junction stays out even though a negation re-includes it (info/exclude alone lost to `!*/`)');
      put(path.join(wt, 'later.txt'), 'later\n');
      const r = await store.restoreDetailed(aid, s1.id);
      A.eq(r && r.ok, true, 'the rewind goes ahead');
      A.ok(!fs.existsSync(path.join(wt, 'later.txt')), 'a file made after the snapshot is removed as before');
      A.ok(isLink(path.join(wt, 'jn')), 'the re-included link is kept (it was never captured)');
      A.eq(listing(outN), { 'n.txt': 'OUTSIDE-N\n' }, 'and nothing behind it moved');
    });

    // ================= 6. names Git would read as patterns are matched literally =================
    row('g1', async () => {
      const aid = 'g1', wt = path.join(ROOT, aid);
      const outG = outside('outG', { 'g.txt': 'OUTSIDE-G\n' });
      put(path.join(wt, 'x1', 'f.txt'), 'x1\n');
      put(path.join(wt, 'ab', 'f.txt'), 'ab\n');
      // Windows file names cannot hold * ? : and lose a trailing space, so those three are POSIX-only rows
      const names = ['x[1]', '#h', '!b', 'a b', ' lead'].concat(isWin ? [] : [':colon', 'q*', 'q?', 'trail ']);
      for (const n of names) link(outG, path.join(wt, n));
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'pattern names' });
      const t1 = s1 ? (await tree(aid, s1.id)) : [];
      A.eq(t1, ['ab/f.txt', 'x1/f.txt'], 'links named like patterns are left out, and the real folders they resemble are kept (' + t1.join(',') + ')');
      A.eq(linkPaths(s1), names.slice().sort(), 'every one is recorded by its own name');
    });

    // ================= 7. maintenance RE-INIT uses the same boundary =================
    row('m1', async () => {
      const aid = 'm1', wt = path.join(ROOT, aid);
      const outM = outside('outM', { 'm.txt': 'OUTSIDE-M\n' });
      put(path.join(wt, 'own.txt'), 'own\n');
      link(outM, path.join(wt, 'jx'));
      const tiny = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, maxRepoBytes: 1 });
      const s1 = await tiny.snapshot(aid, { runId: 'r', turn: 1, label: 'over the ceiling' });
      A.ok(s1 && s1.maintenance && s1.maintenance.reinit === true, 'fixture: the size ceiling re-initialised the shadow repo');
      const row = s1 ? rowOf(tiny, aid, s1.id) : null;
      A.ok(row && row.label === 'baseline (re-init)', 'the restore point handed back is the re-init baseline');
      A.eq(s1 ? (await tree(aid, s1.id)) : [], ['own.txt'], 'the fresh baseline holds nothing from behind the link');
      A.eq(linkPaths(row), ['jx'], 'and its row records the link');
    });

    // ================= 8. MOUNT POINTS and other reparse points, as libuv reports them =================
    row('p1', async () => {
      const aid = 'p1', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      put(path.join(wt, 'mnt', 'on-other-volume.txt'), 'mounted\n');   // a real folder the fake reports as a mount point
      put(path.join(wt, 'cloud.txt'), 'placeholder bytes\n');           // a real file the fake reports as a cloud placeholder
      const mnt = path.join(wt, 'mnt'), cloud = path.join(wt, 'cloud.txt');
      const fakeDirent = (e, kind) => ({ name: e.name, isSymbolicLink: () => kind === 'reparse', isDirectory: () => kind === 'dir', isFile: () => false });
      const promises = Object.create(fs.promises);
      promises.readdir = async (dir, o) => {
        const ents = await fs.promises.readdir(dir, o);
        if (!(o && o.withFileTypes) || path.resolve(String(dir)) !== path.resolve(wt)) return ents;
        return ents.map((e) => (isWin && (e.name === 'mnt' || e.name === 'cloud.txt')) ? fakeDirent(e, 'reparse') : e);
      };
      if (!isWin) {
        const realLstat = fs.promises.lstat.bind(fs.promises);
        promises.lstat = async (p, o) => { const st = await realLstat(p, o); if (path.resolve(String(p)) !== path.resolve(mnt)) return st; return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: st.dev + 1 }); };
      }
      const fakeFs = Object.create(fs);
      Object.defineProperty(fakeFs, 'promises', { value: promises });
      const viaFake = makeCheckpointStore({ fs: fakeFs, pathMod: path, root: ROOT, runGit, clock, keep: 50 });
      const s1 = await viaFake.snapshot(aid, { runId: 'r', turn: 1, label: 'a mount point' });
      const t1 = s1 ? (await tree(aid, s1.id)) : [];
      A.ok(!t1.some((p) => p.startsWith('mnt/')), 'a mount point (a reparse point lstat reads as a plain folder) is never entered (' + t1.join(',') + ')');
      A.ok(s1 && (s1.links || []).some((l) => l.path === 'mnt' && l.kind === 'mount-point'), 'and is recorded as a mount point');
      if (isWin) {
        A.ok(t1.includes('cloud.txt') && !(s1.links || []).some((l) => l.path === 'cloud.txt'), 'a reparse FILE lstat reads as a plain file (a cloud placeholder) is captured like any file');
      }
      void cloud;
    });
    row('p2', async () => {
      // 8b. a DANGLING mount point: libuv's lstat follows a reparse point it cannot read as a link (a mount point named by
      // volume GUID), so a dangling one answers ENOENT. It was 'gone': neither left out nor recorded, and not refused
      const aid = 'p2', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      put(path.join(wt, 'vol', 'data.txt'), 'data\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'vol is a folder' });
      fs.rmSync(path.join(wt, 'vol'), { recursive: true });
      const phantom = { name: 'vol', isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
      const viaFake = makeCheckpointStore({ fs: fsWith({ readdir: async (dir, o) => {
        const ents = await fs.promises.readdir(dir, o);
        return (o && o.withFileTypes && path.resolve(String(dir)) === path.resolve(wt)) ? ents.concat([phantom]) : ents;
      } }), pathMod: path, root: ROOT, runGit, clock, keep: 50 });
      const s1 = await viaFake.snapshot(aid, { runId: 'r', turn: 2, label: 'vol is a dangling mount point' });
      A.ok(s1 && (s1.links || []).some((l) => l.path === 'vol'), 'a reparse point lstat cannot find is recorded as a link (' + JSON.stringify(s1 && s1.links) + ')');
      const rows = viaFake.list(aid).snapshots.length;
      const r = await viaFake.restoreDetailed(aid, s0.id);
      A.eq(r && r.reason, 'link_in_path', 'and a rewind that would write through it is refused, naming it (' + JSON.stringify(r) + ')');
      A.eq(viaFake.list(aid).snapshots.length, rows, 'before anything is touched: no pre-restore row');
      A.ok(!fs.existsSync(path.join(wt, 'vol')), 'and nothing was written where it stands');
    });

    // ================= 9. the BUDGET: an honest skip, never a hang, and a link target is never walked =================
    row('q', async () => {
      const aid = 'q1', wt = path.join(ROOT, aid);
      for (let i = 0; i < 12; i++) put(path.join(wt, 'f' + i + '.txt'), 'f' + i + '\n');
      const small = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanMaxEntries: 5 });
      const s = await small.snapshot(aid, { runId: 'r', turn: 1, label: 'over the entry budget' });
      A.eq(s, null, 'over the entry budget the restore point is skipped');
      const why = small.health(aid) && small.health(aid).lastFailure && small.health(aid).lastFailure.reason;
      A.ok(/could not be checked for links/.test(why || '') && /more than 5 files and folders/.test(why || ''), 'and health says why (' + why + ')');
      const ok = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'normal budget' });
      const rr = await small.restoreDetailed(aid, ok.id);
      A.eq(rr && rr.reason, 'link_check_failed', 'a rewind the walk cannot finish is refused, not run unchecked');
      put(path.join(wt, 'a', 'b', 'c', 'd', 'deep.txt'), 'deep\n');
      const shallow = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanMaxDepth: 2 });
      A.eq(await shallow.snapshot(aid, { runId: 'r', turn: 3 }), null, 'over the depth budget the restore point is skipped');
      A.ok(/deeper than 2 levels/.test(shallow.health(aid).lastFailure.reason), 'and health says so (' + shallow.health(aid).lastFailure.reason + ')');
      let t = 0;
      const slow = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanDeadlineMs: 1000, scanClock: { now: () => (t += 60000) } });
      A.eq(await slow.snapshot(aid, { runId: 'r', turn: 4 }), null, 'over the time budget the restore point is skipped');
      A.ok(/took longer than 1 s/.test(slow.health(aid).lastFailure.reason), 'and health says so (' + slow.health(aid).lastFailure.reason + ')');
      // a junction to a big synthetic tree: the walk never lists it, so a small entry budget is enough
      const big = path.join(BASE, 'big');
      for (let d = 0; d < 30; d++) for (let f = 0; f < 10; f++) await putAsync(path.join(big, 'd' + d, 'f' + f + '.txt'), 'x');
      const aid2 = 'q2', wt2 = path.join(ROOT, aid2);
      put(path.join(wt2, 'own.txt'), 'own\n');
      link(big, path.join(wt2, 'big'));
      const budgeted = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanMaxEntries: 50 });
      const sb = await budgeted.snapshot(aid2, { runId: 'r', turn: 1, label: 'a junction to 300 files' });
      A.ok(sb && sb.created && (await tree(aid2, sb.id)).join() === 'own.txt', 'a junction to 300 files (330 entries walked) costs the walk one entry (budget 50): it is never entered');
      // a .gitignore'd folder is not walked (Git never enters it either), unless a negation could re-include the folder
      const aid3 = 'q3', wt3 = path.join(ROOT, aid3);
      put(path.join(wt3, 'own.txt'), 'own\n');
      for (let i = 0; i < 80; i++) put(path.join(wt3, 'node_modules', 'pkg', 'f' + i + '.js'), 'x');
      put(path.join(wt3, '.gitignore'), 'node_modules/\r\n.vscode/*\r\n!.vscode/settings.json\r\n');
      const pruning = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanMaxEntries: 40 });
      const sp = await pruning.snapshot(aid3, { runId: 'r', turn: 1, label: 'ignored node_modules' });
      A.ok(sp && sp.created, 'an ignored node_modules (80 files, budget 40) is not walked; a negation that cannot re-include it does not change that');
      put(path.join(wt3, '.gitignore'), 'node_modules/\n!node_modules/\n');
      A.eq(await pruning.snapshot(aid3, { runId: 'r', turn: 2, label: 're-included' }), null, 'a negation that re-includes the folder makes the walk enter it (here: over budget, said)');
    });

    // ================= 10. the SSH mirror wipe, the scope statements and the residual =================
    row('ssh', async () => {
      const holder = path.join(BASE, 'mirror'), target = outside('mirrorTarget', { 't.txt': 'T\n' });
      put(path.join(holder, 'sub', 'keep.txt'), 'k\n');
      link(target, path.join(holder, 'sub', 'jt'));
      link(target, path.join(holder, 'jtop'));
      for (const name of fs.readdirSync(holder)) fs.rmSync(path.join(holder, name), { recursive: true, force: true });   // environment.js restoreCheckpoint's wipe
      for (const gone of [path.join(holder, 'sub', 'jt'), path.join(holder, 'jtop')]) { const i = links.indexOf(gone); if (i >= 0 && !fs.existsSync(gone) && !isLink(gone)) links.splice(i, 1); }
      A.eq(listing(target), { 't.txt': 'T\n' }, 'the SSH engine\'s local mirror wipe (fs.rmSync) unlinks a junction without entering it');
      const env = sidecarFunctionSource('createCheckpointRaw');
      // the scope comment is the one right above createCheckpointRaw in environment.js, not the phrase anywhere in sidecar/
      const at = locateSidecarFunction('createCheckpointRaw');
      const envText = at ? ((sidecarSourceFiles().find((f) => f.rel === at.rel) || {}).text || '') : '';
      const above = at ? envText.slice(envText.lastIndexOf('/*', at.index), at.index) : '';
      A.ok(at && at.rel === 'sidecar/environment.js' && /^\/\* THE SSH CHECKPOINT ENGINE AND LINKS/.test(above) && /tar -cf ' \+ quote\(archive\)/.test(env) && !/tar -[a-zA-Z]*h|--dereference/.test(env), 'the SSH engine states its link scope above createCheckpointRaw, and its tar never dereferences a link');
      const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'checkpoint-store.js'), 'utf8');
      const header = storeSrc.slice(0, storeSrc.indexOf("'use strict';"));
      A.ok(/TOCTOU/.test(header) && /checkpoint-manifest/.test(header) && /W2-link-junction-containment/.test(header), 'the store header documents the TOCTOU residual and the Tier 2 lane');
      const route = sidecarTopLevelFunction('handleCheckpointRestore');
      A.ok(/out\.reason === 'link_in_path' \|\| out\.reason === 'link_check_failed'\)\) return json\(409, \{ error: 'restore refused: ' \+ String\(out\.detail/.test(route),
        'the restore route answers a link refusal 409 in the store\'s own words (it would have fallen through to "no such snapshot")');
    });

    // ================= 11. a FOLDER the target holds as a FILE (probe P8): reset empties that folder through its links =================
    row('r1', async () => {
      const aid = 'r1', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      put(path.join(wt, 'a'), 'a was a file\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'a is a file' });
      fs.unlinkSync(path.join(wt, 'a'));
      put(path.join(wt, 'a', 'b', 'real.txt'), 'real\n');
      const outR = outside('outR', { 'o.txt': 'OUTSIDE-R\n', 'deep/d.txt': 'D\n' });
      link(outR, path.join(wt, 'a', 'b', 'jl'));
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'a is a folder holding a link' });
      A.eq(s1 ? (await tree(aid, s1.id)) : [], ['a/b/real.txt', 'own.txt'], 'fixture: a/b/jl is left out of the capture');
      const rowsBefore = store.list(aid).snapshots.length;
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.reason, 'link_in_path', 'a rewind that turns the folder holding a link back into a file is refused (' + JSON.stringify(r) + ')');
      A.ok(r && /"a\/b\/jl" is a link/.test(r.detail || '') && /folder "a"/.test(r.detail || '') && /Nothing was changed/.test(r.detail || ''), 'naming the link and the folder');
      A.eq(store.list(aid).snapshots.length, rowsBefore, 'nothing was touched: no pre-restore row');
      A.eq(listing(outR), { 'deep/d.txt': 'D\n', 'o.txt': 'OUTSIDE-R\n' }, 'the outside folder is whole (reset used to empty it through the junction)');
      A.ok(fs.lstatSync(path.join(wt, 'a')).isDirectory() && isLink(path.join(wt, 'a', 'b', 'jl')), 'the folder and its link are where they were');
    });
    row('r2', async () => {
      // the same for a folder the walk prunes (an ignored build/) and an embedded repository, each in a work tree of its
      // own (together, the embedded repository's capture failure before round 2 hid the build/ deletion): each is
      // listed in full on demand
      const aid = 'r2', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      put(path.join(wt, 'build'), 'build was a file\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'build is a file' });
      fs.unlinkSync(path.join(wt, 'build'));
      put(path.join(wt, '.gitignore'), 'build/\n');
      put(path.join(wt, 'build', 'out.txt'), 'built\n');
      const outB2 = outside('outB2', { 'b.txt': 'OUTSIDE-B2\n' }), outP2 = outside('outP2', { 'p.txt': 'OUTSIDE-P2\n' });
      link(outB2, path.join(wt, 'build', 'jl'));
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'an ignored build/' });
      A.eq(s1 ? (await tree(aid, s1.id)) : [], ['.gitignore', 'own.txt'], 'fixture: build/ is ignored');
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.reason, 'link_in_path', 'turning an ignored folder that holds a link back into a file is refused (' + JSON.stringify(r) + ')');
      A.ok(((r && r.links) || []).some((h) => h.path === 'build' && h.link === 'build/jl'), 'the link in it is found and named');
      A.eq(listing(outB2), { 'b.txt': 'OUTSIDE-B2\n' }, 'the folder behind the ignored link is whole');
      const aidP = 'r2p', wtP = path.join(ROOT, aidP);
      put(path.join(wtP, 'own.txt'), 'own\n');
      put(path.join(wtP, 'proj'), 'proj was a file\n');
      const p0 = await store.snapshot(aidP, { runId: 'r', turn: 1, label: 'proj is a file' });
      fs.unlinkSync(path.join(wtP, 'proj'));
      put(path.join(wtP, 'proj', 'f.txt'), 'f\n');
      await gitInit(path.join(wtP, 'proj'));
      link(outP2, path.join(wtP, 'proj', 'jl'));
      const p1 = await store.snapshot(aidP, { runId: 'r', turn: 2, label: 'a cloned proj/' });
      A.eq(p1 ? (await tree(aidP, p1.id)) : [], ['own.txt', 'proj'], 'fixture: proj/ is one gitlink');
      const rp = await store.restoreDetailed(aidP, p0.id);
      A.eq(rp && rp.reason, 'link_in_path', 'turning an embedded repository that holds a link back into a file is refused (' + JSON.stringify(rp) + ')');
      A.ok(((rp && rp.links) || []).some((h) => h.path === 'proj' && h.link === 'proj/jl'), 'the link in it is found and named');
      A.eq(listing(outP2), { 'p.txt': 'OUTSIDE-P2\n' }, 'the folder behind the link in the embedded repository is whole');
    }, true);

    // ================= 12. a rewind keeps every link and never-captured folder, whatever the target's .gitignore says (no clean) =================
    row('k1', async () => {
      // P2: the target's allowlist .gitignore re-includes every folder, a link only info/exclude kept out among them. clean
      // unlinked it (round 2); with no clean the rewind went ahead and kept it. Since undo review 2 a rewind that changes a
      // .gitignore holding a negation is refused (a negation can re-include what the undo keeps out of its capture), so it
      // touches nothing: the link stays, and nothing behind it moves
      const aid = 'k1', wt = path.join(ROOT, aid);
      put(path.join(wt, '.gitignore'), '*\n!*/\n!*.txt\n!.gitignore\n');
      put(path.join(wt, 'own.txt'), 'own\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'allowlist .gitignore' });
      fs.unlinkSync(path.join(wt, '.gitignore'));
      const outK = outside('outK', { 'n.txt': 'OUTSIDE-K\n', 'deep/m.txt': 'M\n' });
      link(outK, path.join(wt, 'jn'));
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'no .gitignore, a junction' });
      A.eq(linkPaths(s1), ['jn'], 'fixture: the junction is recorded');
      const rows = store.list(aid).snapshots.length;
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq([r && r.ok, r && r.reason, !!(r && r.preRestoreId)], [false, 'uncaptured_check_failed', false], 'a rewind that brings back a .gitignore of negations is refused, with no undo row (' + JSON.stringify(r) + ')');
      A.ok(/"\.gitignore" holds the negation "!\*\/"/.test((r && r.detail) || '') && store.list(aid).snapshots.length === rows && !fs.existsSync(path.join(wt, '.gitignore')), 'naming it, and touching nothing');
      A.ok(isLink(path.join(wt, 'jn')), 'the link is kept (clean used to unlink it)');
      A.eq(listing(outK), { 'deep/m.txt': 'M\n', 'n.txt': 'OUTSIDE-K\n' }, 'and nothing behind it moved');
    });
    row('k2', async () => {
      // P1: a link, and an ignored file, in a folder only the CURRENT .gitignore ignores
      const aid = 'k2', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'before npm install' });
      const libK = outside('libK', { 'index.js': 'LIB-K\n', 'src/core.js': 'CORE-K\n' });
      put(path.join(wt, '.gitignore'), 'node_modules/\n');
      put(path.join(wt, 'node_modules', '.package-lock.json'), '{}\n');
      link(libK, path.join(wt, 'node_modules', 'mylib'));
      await store.snapshot(aid, { runId: 'r', turn: 2, label: 'npm install ../mylib' });
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.ok, true, 'the rewind to before the .gitignore goes ahead (' + JSON.stringify(r) + ')');
      A.ok(!fs.existsSync(path.join(wt, '.gitignore')), 'the .gitignore the target lacks is gone');
      A.ok(isLink(path.join(wt, 'node_modules', 'mylib')), 'the link in the folder only that .gitignore ignored is kept');
      A.ok(fs.existsSync(path.join(wt, 'node_modules', '.package-lock.json')), 'and so is the ignored file beside it: it was never captured, so removing it could not be undone');
      A.eq(listing(libK), { 'index.js': 'LIB-K\n', 'src/core.js': 'CORE-K\n' }, 'the linked library is whole');
    });

    // ================= 13. EMBEDDED REPOSITORIES: Git records a gitlink and never reads inside, and neither does the walk =================
    row('c1', async () => {
      const aid = 'c1', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own 0\n');
      put(path.join(wt, 'clone', 'README'), 'r\n');
      for (let i = 0; i < 60; i++) put(path.join(wt, 'clone', 'src', 'f' + i + '.js'), 'x');
      await gitInit(path.join(wt, 'clone'));
      const outC = outside('outC', { 'x.txt': 'OUTSIDE-C\n' });
      fs.mkdirSync(path.join(wt, 'clone', 'sub'));
      link(outC, path.join(wt, 'clone', 'sub', 'j'));
      const ids = [];
      for (let i = 1; i <= 3; i++) {
        put(path.join(wt, 'own.txt'), 'own ' + i + '\n');
        const s = await store.snapshot(aid, { runId: 'r', turn: i, label: 'turn ' + i });
        A.ok(s && s.created && store.health(aid).ok === true, 'snapshot ' + i + ' of a workspace holding a clone with a junction is saved (' + JSON.stringify(store.health(aid).lastFailure) + ')');
        if (s) ids.push(s.id);
      }
      A.eq(ids.length ? (await tree(aid, ids[0])) : [], ['clone', 'own.txt'], 'the clone is one gitlink');
      A.eq(linkPaths(rowOf(store, aid, ids[2])), [], 'and no link inside it is recorded: Git never reads there');
      const r = await store.restoreDetailed(aid, ids[0]);
      A.eq(r && r.ok, true, 'a rewind goes ahead (' + JSON.stringify(r) + ')');
      A.eq(fs.readFileSync(path.join(wt, 'own.txt'), 'utf8'), 'own 1\n', 'and rewinds the workspace');
      A.ok(isLink(path.join(wt, 'clone', 'sub', 'j')) && fs.existsSync(path.join(wt, 'clone', '.git', 'HEAD')), 'the clone and its link are untouched');
      A.eq(listing(outC), { 'x.txt': 'OUTSIDE-C\n' }, 'and nothing behind the link moved');
      put(path.join(wt, 'own.txt'), 'own 4\n');
      const small = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanMaxEntries: 30 });
      const sb = await small.snapshot(aid, { runId: 'r', turn: 4, label: 'budget 30' });
      A.ok(sb && sb.created, 'the clone\'s 60 files cost the walk nothing (budget 30): it is never entered');
    }, true);
    row('c2', async () => {
      // a `git init` in a folder the shadow repo already tracks: Git keeps reading it as a folder, so the walk enters it too
      const aid = 'c2', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app', 'a.txt'), 'a\n');
      await store.snapshot(aid, { runId: 'r', turn: 1, label: 'app tracked' });
      await gitInit(path.join(wt, 'app'));
      const outC2 = outside('outC2', { 'y.txt': 'OUTSIDE-C2\n' });
      link(outC2, path.join(wt, 'app', 'jl'));
      put(path.join(wt, 'app', 'b.txt'), 'b\n');
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'git init in app' });
      A.eq(s1 ? (await tree(aid, s1.id)) : [], ['app/a.txt', 'app/b.txt'], 'Git still captures the folder\'s files, and nothing from behind its link');
      A.eq(linkPaths(s1), ['app/jl'], 'because the walk entered the folder and left the link out');
    });
    row('c3', async () => {
      // an embedded repository whose .git went away: the index still holds the gitlink, so Git still never reads inside
      const aid = 'c3', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own 0\n');
      put(path.join(wt, 'proj', 'f.txt'), 'f\n');
      await gitInit(path.join(wt, 'proj'));
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'proj is a gitlink' });
      fs.rmSync(path.join(wt, 'proj', '.git'), { recursive: true, force: true });
      const outC3 = outside('outC3', { 'z.txt': 'OUTSIDE-C3\n' });
      link(outC3, path.join(wt, 'proj', 'jl'));
      put(path.join(wt, 'own.txt'), 'own 1\n');
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'proj lost its .git and holds a junction' });
      A.ok(s1 && s1.created && store.health(aid).ok === true, 'the snapshot is saved: a link below a gitlink is outside Git\'s view (' + JSON.stringify(store.health(aid).lastFailure) + ')');
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.ok, true, 'and a rewind goes ahead (' + JSON.stringify(r) + ')');
      A.ok(isLink(path.join(wt, 'proj', 'jl')), 'leaving the link in place');
      A.eq(listing(outC3), { 'z.txt': 'OUTSIDE-C3\n' }, 'with nothing behind it moved');
    });

    // ================= 14. the recorded links do not depend on the order the folders were listed in =================
    row('o1', async () => {
      const aid = 'o1', wt = path.join(ROOT, aid);
      const outO = outside('outO', { 'x.txt': 'x\n' });
      const dirs = ['a', 'b', 'c', 'd'];
      for (const d of dirs) { put(path.join(wt, d, 'f.txt'), d + '\n'); link(outO, path.join(wt, d, 'j')); }
      // the four folders finish listing in a different order on every snapshot (as a loaded thread pool may)
      let round = 0;
      const jittered = fsWith({ readdir: async (dir, o) => {
        const rel = path.relative(wt, String(dir)), i = dirs.indexOf(rel);
        if (rel === '') round++;
        if (i >= 0) await new Promise((res) => setTimeout(res, ((i + round) % 4) * 15));
        return fs.promises.readdir(dir, o);
      } });
      const st = makeCheckpointStore({ fs: jittered, pathMod: path, root: ROOT, runGit, clock, keep: 50 });
      const first = await st.snapshot(aid, { runId: 'r', turn: 1, label: 'four links' });
      A.eq(((first && first.links) || []).map((l) => l.path), ['a/j', 'b/j', 'c/j', 'd/j'], 'the links are recorded in path order');
      for (let i = 0; i < 3; i++) {
        const s = await st.snapshot(aid, { runId: 'r', turn: 2 + i, label: 'unchanged ' + i });
        A.ok(s && s.created === false && s.id === first.id, 'an unchanged tree dedups whatever order its folders were listed in (' + i + ': ' + JSON.stringify(s && { created: s.created, links: s.links }) + ')');
      }
      A.eq(st.list(aid).snapshots.length, 1, 'one row, not one per snapshot');
    });

    // ================= 15. POSIX: a work-tree root that is itself a link to another file system =================
    row('x1', async () => {
      const aid = 'x1', wt = path.join(ROOT, aid);
      for (const [rel, body] of [['own.txt', 'o'], ['src/a.js', 'a'], ['docs/b.md', 'b']]) put(path.join(wt, rel), body);
      // the POSIX branch (sep '/', also on Windows), whose lstat of the root reports the link's own device (dev + 1)
      const sameAsRoot = (p) => path.resolve(String(p)).toLowerCase() === path.resolve(wt).toLowerCase();
      const linkedRoot = fsWith({ lstat: async (p, o) => {
        const st = await fs.promises.lstat(p, o);
        return sameAsRoot(p) ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: st.dev + 1 }) : st;
      } });
      const posixish = isWin ? Object.assign({}, path.win32, { sep: '/' }) : path;
      const st = makeCheckpointStore({ fs: linkedRoot, pathMod: posixish, root: ROOT, runGit, clock, keep: 50 });
      const s = await st.snapshot(aid, { runId: 'r', turn: 1, label: 'root through a link' });
      A.eq(s ? (await tree(aid, s.id)) : [], ['docs/b.md', 'own.txt', 'src/a.js'], 'every folder is captured: the root\'s device is read through the link (it made every folder a mount point)');
      A.eq(linkPaths(s), [], 'and none is recorded as a link');
    });

    // ================= 16. review round 3: P8 at any depth, `.git` links, Git's own gitfile parse, the clean's bound =================
    row('d1', async () => {
      // P8 one level INSIDE a folder the walk does not enter: the target holds FILES at build/sub (build/ is ignored now)
      // and proj/sub (proj is an embedded clone now), and each of those folders now holds a junction
      const aid = 'd1', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      put(path.join(wt, 'build', 'sub'), 'build/sub was a file\n');
      put(path.join(wt, 'proj', 'sub'), 'proj/sub was a file\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'build/sub and proj/sub are files' });
      fs.rmSync(path.join(wt, 'proj'), { recursive: true });
      await store.snapshot(aid, { runId: 'r', turn: 2, label: 'proj gone' });   // so the clone below is untracked: one gitlink
      fs.unlinkSync(path.join(wt, 'build', 'sub'));
      put(path.join(wt, '.gitignore'), 'build/\n');
      put(path.join(wt, 'build', 'sub', 'k.txt'), 'k\n');
      const outD1 = outside('outD1', { 'b.txt': 'OUTSIDE-D1\n', 'deep/m.txt': 'M\n' });
      const outD2 = outside('outD2', { 'p.txt': 'OUTSIDE-D2\n', 'deep/m.txt': 'M\n' });
      link(outD1, path.join(wt, 'build', 'sub', 'jl'));
      put(path.join(wt, 'proj', 'README'), 'clone\n');
      put(path.join(wt, 'proj', 'sub', 'k.txt'), 'k\n');
      await gitInit(path.join(wt, 'proj'));
      link(outD2, path.join(wt, 'proj', 'sub', 'jl'));
      const s2 = await store.snapshot(aid, { runId: 'r', turn: 3, label: 'build ignored, proj a clone, each sub/ holding a junction' });
      A.eq(s2 ? (await tree(aid, s2.id)) : [], ['.gitignore', 'own.txt', 'proj'], 'fixture: build/ is ignored and proj/ is one gitlink');
      const rowsBefore = store.list(aid).snapshots.length;
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.reason, 'link_in_path', 'turning a folder INSIDE an ignored folder or an embedded repository back into a file is refused (' + JSON.stringify(r) + ')');
      const named = (r && r.links) || [];
      A.ok(named.some((h) => h.path === 'build/sub' && h.link === 'build/sub/jl') && named.some((h) => h.path === 'proj/sub' && h.link === 'proj/sub/jl'), 'naming both folders and their links');
      A.eq(store.list(aid).snapshots.length, rowsBefore, 'nothing was touched: no pre-restore row');
      A.eq(listing(outD1), { 'b.txt': 'OUTSIDE-D1\n', 'deep/m.txt': 'M\n' }, 'the folder behind the junction in the ignored build/sub is whole (reset emptied it)');
      A.eq(listing(outD2), { 'deep/m.txt': 'M\n', 'p.txt': 'OUTSIDE-D2\n' }, 'the folder behind the junction in the clone\'s proj/sub is whole (reset emptied it)');
    });
    row('d2', async () => {
      // a `.git` that is ITSELF a link, in a folder the walk enters, where the target holds a FILE: Git never reads a `.git`,
      // so it was never a recorded link, but reset empties the folder through it. x/.git: a relocated git-dir (a real
      // repository's .git, linked back; x is tracked); y/.git: a junction to a plain folder (y is untracked)
      const aid = 'd2', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      put(path.join(wt, 'x'), 'x was a file\n');
      put(path.join(wt, 'y'), 'y was a file\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'x and y are files' });
      fs.unlinkSync(path.join(wt, 'x'));
      fs.unlinkSync(path.join(wt, 'y'));
      put(path.join(wt, 'x', 'f.txt'), 'f\n');
      await store.snapshot(aid, { runId: 'r', turn: 2, label: 'x a tracked folder' });
      const repo = outside('repoD2', { 'r.txt': 'r\n' });
      await gitInit(repo);
      const repoGit = path.join(repo, '.git'), gitFiles = Object.keys(listing(repoGit)).length;
      link(repoGit, path.join(wt, 'x', '.git'));
      put(path.join(wt, 'y', 'g.txt'), 'g\n');
      const outY = outside('outD2y', { 'y.txt': 'OUTSIDE-Y\n', 'deep/m.txt': 'M\n' });
      link(outY, path.join(wt, 'y', '.git'));
      const s2 = await store.snapshot(aid, { runId: 'r', turn: 3, label: 'x/.git and y/.git are junctions' });
      A.eq(s2 ? (await tree(aid, s2.id)) : [], ['own.txt', 'x/f.txt', 'y/g.txt'], 'fixture: both folders are walked and captured, no `.git` content');
      const rowsBefore = store.list(aid).snapshots.length;
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.reason, 'link_in_path', 'turning a folder whose `.git` is a link back into a file is refused (' + JSON.stringify(r) + ')');
      const named = (r && r.links) || [];
      A.ok(named.some((h) => h.path === 'x' && h.link === 'x/.git') && named.some((h) => h.path === 'y' && h.link === 'y/.git'), 'naming both `.git` links');
      A.eq(store.list(aid).snapshots.length, rowsBefore, 'nothing was touched: no pre-restore row');
      A.ok(fs.existsSync(path.join(repoGit, 'HEAD')) && Object.keys(listing(repoGit)).length === gitFiles, 'the relocated git-dir is whole (reset deleted every file of it, HEAD too)');
      A.eq(listing(outY), { 'deep/m.txt': 'M\n', 'y.txt': 'OUTSIDE-Y\n' }, 'the folder behind y/.git is whole');
    });
    row('d3', async () => {
      // a `.git` FILE that Git does not read as a gitfile (setup.c read_gitfile_gently: exactly "gitdir: ", then the whole
      // rest of the file minus its trailing CR/LF): Git reads that folder like any other, so the walk must enter it too
      const aid = 'd3', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      const repo = outside('repoD3', { 'r.txt': 'r\n' });
      await gitInit(repo);
      const gd = path.join(repo, '.git').replace(/\\/g, '/');
      const outG = outside('outD3', { 'secret.txt': 'OUTSIDE-D3\n' });
      const gitfiles = {
        good: 'gitdir: ' + gd + '\r\n',                    // the control: an exact gitfile, an embedded repository to Git
        nospace: 'gitdir:' + gd + '\n', twospace: 'gitdir:  ' + gd + '\n', tab: 'gitdir:\t' + gd + '\n', twolines: 'gitdir: ' + gd + '\nextra\n'
      };
      for (const [name, body] of Object.entries(gitfiles)) {
        put(path.join(wt, name, 'README'), name + '\n');
        put(path.join(wt, name, '.git'), body);
        link(outG, path.join(wt, name, 'jl'));
      }
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'gitfiles Git reads and does not' });
      const t1 = s1 ? (await tree(aid, s1.id)) : [];
      A.ok(!t1.some((p) => /\/jl(\/|$)/.test(p)), 'nothing from behind a link is captured (' + t1.join(',') + ')');
      A.eq(t1, ['good', 'nospace/README', 'own.txt', 'tab/README', 'twolines/README', 'twospace/README'], 'the folders Git reads are captured, and the exact gitfile is one gitlink');
      A.eq(linkPaths(s1), ['nospace/jl', 'tab/jl', 'twolines/jl', 'twospace/jl'], 'the links in the folders Git reads are left out and recorded');
      A.eq(listing(outG), { 'secret.txt': 'OUTSIDE-D3\n' }, 'the outside folder is untouched');
    });
    row('d4', async () => {
      // an ordinary tree with hundreds of ignored folders and no link: a rewind keeps them (round 2's clean needed one
      // pattern per folder, 700 went past its bound and every rewind was refused; round 5 removed the clean)
      const aid = 'd4', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.py'), 'v0\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'before the packages' });
      put(path.join(wt, '.gitignore'), '__pycache__/\n');
      put(path.join(wt, 'app.py'), 'v1\n');
      const pkg = (i) => 'package_module_' + String(i).padStart(3, '0');
      for (let i = 0; i < 700; i++) {
        await putAsync(path.join(wt, pkg(i), 'mod.py'), 'm\n');
        await putAsync(path.join(wt, pkg(i), '__pycache__', 'mod.cpython-312.pyc'), 'pyc\n');
      }
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: '700 packages' });
      A.ok(s1 && s1.created && !(await tree(aid, s1.id)).some((p) => p.includes('__pycache__')), 'fixture: 700 ignored __pycache__ folders, none captured');
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.ok, true, 'a rewind goes ahead (it was refused: more ignored folders than a rewind can keep) (' + JSON.stringify(r) + ')');
      A.eq(fs.readFileSync(path.join(wt, 'app.py'), 'utf8'), 'v0\n', 'and rewinds');
      A.ok(!fs.existsSync(path.join(wt, '.gitignore')) && !fs.existsSync(path.join(wt, pkg(0), 'mod.py')), 'removing what the target lacks');
      A.ok([0, 350, 699].every((i) => fs.existsSync(path.join(wt, pkg(i), '__pycache__', 'mod.cpython-312.pyc'))),
        'while every never-captured ignored folder stays, though the target has no .gitignore to ignore it');
    }, true);

    // ================= 17. review round 4: a link inside a real `.git` folder, and the clean's bound by folder name =================
    row('g4', async () => {
      // the target holds proj as a FILE; proj is now an embedded clone whose .git/hooks is a junction to a shared hooks
      // folder. entry.c remove_subtree has no case for `.git`: reset emptied the hooks folder through it and said ok
      const aid = 'g4', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      put(path.join(wt, 'proj'), 'proj was a file\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'proj is a file' });
      fs.unlinkSync(path.join(wt, 'proj'));
      put(path.join(wt, 'proj', 'README'), 'clone\n');
      await gitInit(path.join(wt, 'proj'));
      const hooks = outside('outG4', { 'pre-commit': 'SHARED-HOOK\n', 'deep/m.txt': 'M\n' });
      fs.rmSync(path.join(wt, 'proj', '.git', 'hooks'), { recursive: true, force: true });
      link(hooks, path.join(wt, 'proj', '.git', 'hooks'));
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'proj a clone, its hooks linked' });
      A.eq(s1 ? (await tree(aid, s1.id)) : [], ['own.txt', 'proj'], 'fixture: proj is one gitlink');
      A.eq(linkPaths(s1), [], 'and no link inside its `.git` is recorded: Git never reads there');
      const rowsBefore = store.list(aid).snapshots.length;
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.reason, 'link_in_path', 'turning a clone whose .git/hooks is a junction back into a file is refused (' + JSON.stringify(r) + ')');
      A.ok(((r && r.links) || []).some((h) => h.path === 'proj' && h.link === 'proj/.git/hooks'), 'naming the folder and the link inside its `.git`');
      A.eq(store.list(aid).snapshots.length, rowsBefore, 'nothing was touched: no pre-restore row');
      A.eq(listing(hooks), { 'deep/m.txt': 'M\n', 'pre-commit': 'SHARED-HOOK\n' }, 'the shared hooks folder is whole (reset emptied it)');
      A.ok(isLink(path.join(wt, 'proj', '.git', 'hooks')) && fs.existsSync(path.join(wt, 'proj', '.git', 'HEAD')), 'the clone and its link are where they were');
    });
    row('g5', async () => {
      // a walked folder whose `.git` is a plain folder (no repository), with nothing else to check in the whole tree: the
      // target holds x and w as FILES, and x/.git/lfs and w/sub/.git/modules/m (two folders inside a `.git`, one folder
      // below the one replaced) are junctions. The check used to return before asking any folder
      const aid = 'g5', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      put(path.join(wt, 'x'), 'x was a file\n');
      put(path.join(wt, 'w'), 'w was a file\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'x and w are files' });
      fs.unlinkSync(path.join(wt, 'x'));
      fs.unlinkSync(path.join(wt, 'w'));
      put(path.join(wt, 'x', 'f.txt'), 'f\n');
      fs.mkdirSync(path.join(wt, 'x', '.git'));
      const lfs = outside('outG5x', { 'objects/aa.bin': 'LFS-OBJECT\n', 'deep/m.txt': 'M\n' });
      link(lfs, path.join(wt, 'x', '.git', 'lfs'));
      put(path.join(wt, 'w', 'sub', 'g.txt'), 'g\n');
      fs.mkdirSync(path.join(wt, 'w', 'sub', '.git', 'modules'), { recursive: true });
      const mod = outside('outG5w', { 'm.txt': 'OUTSIDE-W\n' });
      link(mod, path.join(wt, 'w', 'sub', '.git', 'modules', 'm'));
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'x and w are folders, links inside their .git' });
      A.eq(s1 ? (await tree(aid, s1.id)) : [], ['own.txt', 'w/sub/g.txt', 'x/f.txt'], 'fixture: both folders are walked, nothing of a `.git` is captured');
      A.eq(linkPaths(s1), [], 'and no link inside a `.git` is recorded');
      const rowsBefore = store.list(aid).snapshots.length;
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.reason, 'link_in_path', 'turning a folder whose `.git` holds a link back into a file is refused (' + JSON.stringify(r) + ')');
      const named = (r && r.links) || [];
      A.ok(named.some((h) => h.path === 'x' && h.link === 'x/.git/lfs') && named.some((h) => h.path === 'w' && h.link === 'w/sub/.git/modules/m'), 'naming both links');
      A.eq(store.list(aid).snapshots.length, rowsBefore, 'nothing was touched: no pre-restore row');
      A.eq(listing(lfs), { 'deep/m.txt': 'M\n', 'objects/aa.bin': 'LFS-OBJECT\n' }, 'the folder behind x/.git/lfs is whole (reset emptied it)');
      A.eq(listing(mod), { 'm.txt': 'OUTSIDE-W\n' }, 'the folder behind w/sub/.git/modules/m is whole');
    });
    row('g7', async () => {
      // the control: a rewind that replaces no folder goes ahead past a link inside a `.git`, and leaves both alone
      const aid = 'g7', wt = path.join(ROOT, aid);
      put(path.join(wt, 'x', 'f.txt'), 'f\n');
      fs.mkdirSync(path.join(wt, 'x', '.git'));
      const lfs = outside('outG7', { 'objects/aa.bin': 'LFS-OBJECT\n' });
      link(lfs, path.join(wt, 'x', '.git', 'lfs'));
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'x/f.txt' });
      put(path.join(wt, 'x', 'g.txt'), 'g\n');
      await store.snapshot(aid, { runId: 'r', turn: 2, label: 'x/g.txt added' });
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.ok, true, 'a rewind that replaces no folder is not refused by a link inside a `.git` (' + JSON.stringify(r) + ')');
      A.ok(!fs.existsSync(path.join(wt, 'x', 'g.txt')) && isLink(path.join(wt, 'x', '.git', 'lfs')), 'it rewinds, and the link stays');
      A.eq(listing(lfs), { 'objects/aa.bin': 'LFS-OBJECT\n' }, 'with nothing behind it moved');
    });
    row('g6', async () => {
      // a monorepo whose 400 packages each list their own build folders in their own .gitignore (one rule anchored, two
      // not), names the root .gitignore lacks, and no link: one clean pattern per rule base was 1200 patterns, past the
      // bound, so every rewind was refused (round 4: one per folder NAME; round 5: no clean at all)
      const aid = 'g6', wt = path.join(ROOT, aid);
      put(path.join(wt, 'package.json'), '{"v":0}\n');
      put(path.join(wt, '.gitignore'), 'node_modules/\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'before the packages' });
      put(path.join(wt, 'package.json'), '{"v":1}\n');
      const pkg = (i) => path.join(wt, 'packages', 'pkg-' + String(i).padStart(4, '0'));
      for (let i = 0; i < 400; i++) {
        await putAsync(path.join(pkg(i), 'package.json'), '{}\n');
        await putAsync(path.join(pkg(i), '.gitignore'), '/dist/\n.turbo/\ncoverage/\n');
        for (const n of ['dist', '.turbo', 'coverage']) await putAsync(path.join(pkg(i), n, 'out.txt'), 'built\n');
      }
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: '400 packages' });
      A.ok(s1 && s1.created && !(await tree(aid, s1.id)).some((p) => /\/(dist|\.turbo|coverage)\//.test(p)), 'fixture: 1200 ignored folders under 400 package .gitignore files, none captured');
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.ok, true, 'a rewind goes ahead (it was refused: more ignored folders than a rewind can keep) (' + JSON.stringify(r) + ')');
      A.eq(fs.readFileSync(path.join(wt, 'package.json'), 'utf8'), '{"v":0}\n', 'and rewinds');
      A.ok(!fs.existsSync(path.join(pkg(0), 'package.json')) && !fs.existsSync(path.join(pkg(399), '.gitignore')), 'removing what the target lacks');
      A.ok([0, 200, 399].every((i) => ['dist', '.turbo', 'coverage'].every((n) => fs.existsSync(path.join(pkg(i), n, 'out.txt')))),
        'while every never-captured ignored folder stays, anchored rule or not, though no .gitignore is left to ignore it');
    }, true);

    // ================= 18. review round 5: a rewind deletes no file no capture took; `.git` links in a folder the target lacks; Git's own count =================
    row('v1', async () => {
      // the target has no .gitignore; now .env, src/y.log (a glob rule) and tmp-1/k.txt (a glob folder rule) are ignored, so
      // no capture took them. reset wrote the target's tree (no .gitignore), then `clean -fd` deleted all three for good,
      // undo or not (trunk d5024f5a did the same). With no clean (round 5) they stayed, and the undo, a rewind under the
      // target's rules, took .env and the log with its own capture and deleted them with its reset, held in its own undo
      // row only (2d1c2fb9 the same). Since undo review 2 a rewind that changes a rule beyond one plain name (*.log,
      // tmp-*/) is refused, untouched: no capture of either side can keep in place what such a rule ignores
      const aid = 'v1', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.js'), 'v0\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'before .gitignore' });
      put(path.join(wt, '.gitignore'), '.env\n*.log\ntmp-*/\n');
      put(path.join(wt, '.env'), 'API_KEY=fixture-only\n');
      put(path.join(wt, 'src', 'y.log'), 'log\n');
      put(path.join(wt, 'tmp-1', 'k.txt'), 'k\n');
      put(path.join(wt, 'app.js'), 'v1\n');
      put(path.join(wt, 'added', 'deep', 'n.txt'), 'n\n');
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'a .gitignore, .env and logs' });
      A.eq(s1 ? (await tree(aid, s1.id)) : [], ['.gitignore', 'added/deep/n.txt', 'app.js'], 'fixture: no capture took .env, src/y.log or tmp-1/k.txt');
      const rows = store.list(aid).snapshots.length, before = listing(wt);
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq([r && r.ok, r && r.reason, !!(r && r.preRestoreId)], [false, 'uncaptured_check_failed', false], 'the rewind to before a .gitignore of glob rules is refused, with no undo row (' + JSON.stringify(r) + ')');
      A.ok(/rewinding changes the rule "\*\.log" in "\.gitignore", which is not one plain name/.test((r && r.detail) || ''), 'naming the rule');
      A.eq([store.list(aid).snapshots.length, listing(wt)], [rows, before], 'nothing was touched: .env, src/y.log and tmp-1/k.txt where they were, with every other path and byte');
    });
    row('v1b', async () => {
      // 18a: the same with plain names only (.env, logs/): the rewind goes ahead and keeps both (no capture took them; no
      // clean), and its undo, under the target's rules (no .gitignore), keeps them out of its own capture by an info/exclude
      // line (scanTree's keptFile and keptOut), so its reset never deletes them: every path and byte comes back. Before undo
      // review 2 the undo's capture took .env and its reset deleted it (2d1c2fb9 the same)
      const aid = 'v1b', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.js'), 'v0\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'before .gitignore' });
      put(path.join(wt, '.gitignore'), '.env\nlogs/\n');
      put(path.join(wt, '.env'), 'API_KEY=fixture-only\n');
      put(path.join(wt, 'logs', 'a.log'), 'log\n');
      put(path.join(wt, 'app.js'), 'v1\n');
      put(path.join(wt, 'added', 'deep', 'n.txt'), 'n\n');
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'a .gitignore of plain names, .env and logs' });
      A.eq(s1 ? (await tree(aid, s1.id)) : [], ['.gitignore', 'added/deep/n.txt', 'app.js'], 'fixture: no capture took .env or logs/a.log');
      const before = listing(wt);
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.ok, true, 'the rewind to before the .gitignore goes ahead (' + JSON.stringify(r) + ')');
      A.eq(listing(wt), { '.env': 'API_KEY=fixture-only\n', 'app.js': 'v0\n', 'logs/a.log': 'log\n' },
        'and rewinds, removing the captured files the target lacks and the folders that left empty, keeping .env and logs/a.log (clean deleted them for good)');
      const u = await store.restoreDetailed(aid, (r && r.preRestoreId) || '');
      A.eq(u && u.ok, true, 'restoreDetailed(the rewind\'s preRestoreId) goes ahead (' + JSON.stringify(u) + ')');
      A.eq(listing(wt), before, 'and every path and byte is back, .env and logs/a.log never taken off disk');
      A.ok(!!(u && u.preRestoreId) && !(await tree(aid, u.preRestoreId)).some((p) => p === '.env' || /^logs\//.test(p)), 'the undo\'s own capture left both out (its row\'s .gitignore lists them)');
    });
    row('v2', async () => {
      // a `.git` link, or a link inside a plain `.git` folder, in a folder the target lacks: the rewind deleted the files the
      // capture took there and left the folder, its `.git` and the link where they were (no clean; reset never enters a
      // `.git`). Its undo then wrote those files back below a folder holding a `.git` that its target, the undo row, holds no
      // folder at: since undo review 2 (the store's repoOnPath) a rewind that deletes there is refused, so that its undo is
      // never one that writes below what Git may take for a repository. Nothing moves, behind either link
      const aid = 'v2', wt = path.join(ROOT, aid);
      put(path.join(wt, 'own.txt'), 'own\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'neither y nor y2' });
      put(path.join(wt, 'y', 'f.txt'), 'f\n');
      fs.mkdirSync(path.join(wt, 'y', '.git'));
      const outY = outside('outV2y', { 'objects/aa.bin': 'LFS-OBJECT\n', 'deep/m.txt': 'M\n' });
      link(outY, path.join(wt, 'y', '.git', 'lfs'));
      put(path.join(wt, 'y2', 'f.txt'), 'f2\n');
      const outY2 = outside('outV2y2', { 'objects/bb.bin': 'GIT-DATA\n', 'deep/m.txt': 'M2\n' });
      link(outY2, path.join(wt, 'y2', '.git'));
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'y and y2, their .git data linked' });
      A.eq(s1 ? (await tree(aid, s1.id)) : [], ['own.txt', 'y/f.txt', 'y2/f.txt'], 'fixture: both folders are walked, nothing of a `.git` is captured');
      A.eq(linkPaths(s1), [], 'and neither a `.git` link nor a link inside a `.git` is recorded');
      const rows = store.list(aid).snapshots.length;
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq([r && r.ok, r && r.reason, !!(r && r.preRestoreId)], [false, 'uncaptured_in_path', false], 'a rewind that would delete inside a folder holding a `.git` the target lacks is refused, with no undo row (' + JSON.stringify(r) + ')');
      A.ok(/^"y" is an embedded Git repository/.test((r && r.detail) || '') && store.list(aid).snapshots.length === rows, 'naming the folder');
      A.ok(bodyOf(path.join(wt, 'y', 'f.txt')) === 'f\n' && bodyOf(path.join(wt, 'y2', 'f.txt')) === 'f2\n', 'and touching nothing: both files are where they were');
      A.ok(isLink(path.join(wt, 'y', '.git', 'lfs')) && isLink(path.join(wt, 'y2', '.git')), 'and leaves y/.git/lfs and y2/.git where they are');
      A.eq(listing(outY), { 'deep/m.txt': 'M\n', 'objects/aa.bin': 'LFS-OBJECT\n' }, 'the folder behind y/.git/lfs is whole');
      A.eq(listing(outY2), { 'deep/m.txt': 'M2\n', 'objects/bb.bin': 'GIT-DATA\n' }, 'the folder behind y2/.git is whole');
    });
    row('v3', async () => {
      // Git's own data has a count of its own. The target holds x as a FILE; x is now a folder whose plain .git holds 30
      // entries, beside 19 of the person's own: with a budget of 40, one shared count (49) refused the rewind with a number
      // the person could not relate to. Past its own count the refusal names the `.git`. Within it (round 6): reset would
      // delete that `.git` with x and no capture took it, so the rewind is refused for that (round 5 let it go ahead)
      const budget = makeCheckpointStore({ fs, pathMod: path, root: ROOT, runGit, clock, keep: 50, scanMaxEntries: 40 });
      const shape = async function (aid, objects) {
        const wt = path.join(ROOT, aid);
        put(path.join(wt, 'own.txt'), 'own\n');
        put(path.join(wt, 'x'), 'x was a file\n');
        const s0 = await budget.snapshot(aid, { runId: 'r', turn: 1, label: 'x is a file' });
        fs.unlinkSync(path.join(wt, 'x'));
        put(path.join(wt, 'x', 'f.txt'), 'f\n');
        for (let i = 0; i < 15; i++) put(path.join(wt, 'w' + i + '.txt'), 'w\n');
        for (let i = 0; i < objects; i++) put(path.join(wt, 'x', '.git', 'objects', 'o' + i), 'o\n');
        const s1 = await budget.snapshot(aid, { runId: 'r', turn: 2, label: 'x is a folder with Git data' });
        A.ok(s0 && s1 && s1.created, 'fixture: the walk itself (19 entries) is within the budget of 40');
        return { wt: wt, s0: s0 };
      };
      const ok = await shape('v3', 29);
      const rowsV3 = budget.list('v3').snapshots.length;
      const r = await budget.restoreDetailed('v3', ok.s0.id);
      A.eq(r && r.reason, 'uncaptured_in_path', 'a rewind whose `.git` listing (30 entries) and own files (19) are each within 40 is not refused over a count, but over the `.git` it would delete (' + JSON.stringify(r) + ')');
      A.ok(r && /"x\/\.git"/.test(r.detail || '') && /Nothing was changed/.test(r.detail || ''), 'naming it');
      A.eq(budget.list('v3').snapshots.length, rowsV3, 'nothing was touched: no pre-restore row');
      A.ok(fs.statSync(path.join(ok.wt, 'x')).isDirectory() && fs.existsSync(path.join(ok.wt, 'x', '.git', 'objects', 'o28')), 'and x/.git is whole');
      const over = await shape('v4', 45);
      const rowsBefore = budget.list('v4').snapshots.length;
      const r2 = await budget.restoreDetailed('v4', over.s0.id);
      A.eq(r2 && r2.reason, 'link_check_failed', 'past its own count of 40 the rewind is refused (' + JSON.stringify(r2) + ')');
      A.ok(r2 && /"x\/\.git"/.test(r2.detail || '') && /more than 40 files and folders/.test(r2.detail || ''), 'naming the `.git` it was listing');
      A.eq(budget.list('v4').snapshots.length, rowsBefore, 'nothing was touched: no pre-restore row');
      A.ok(fs.existsSync(path.join(over.wt, 'x', '.git', 'objects', 'o0')), 'and x/.git is where it was');
      // and the person's own count, on a folder the walk pruned and the check lists on demand: the target holds a FILE
      // `build`, and build/ is now an ignored folder of 45 files with no link in it
      const wt5 = path.join(ROOT, 'v5');
      put(path.join(wt5, 'build'), 'build was a file\n');
      const p0 = await budget.snapshot('v5', { runId: 'r', turn: 1, label: 'build is a file' });
      fs.unlinkSync(path.join(wt5, 'build'));
      put(path.join(wt5, '.gitignore'), 'build/\n');
      for (let i = 0; i < 45; i++) put(path.join(wt5, 'build', 'o' + i + '.js'), 'o\n');
      const p1 = await budget.snapshot('v5', { runId: 'r', turn: 2, label: 'an ignored build/ of 45 files' });
      A.ok(p0 && p1 && p1.created, 'fixture: the walk prunes build/, so the capture is within the budget of 40');
      const rows5 = budget.list('v5').snapshots.length;
      const r3 = await budget.restoreDetailed('v5', p0.id);
      A.eq(r3 && r3.reason, 'link_check_failed', 'a rewind that would delete a pruned folder it cannot list within the count is refused, not run unchecked (' + JSON.stringify(r3) + ')');
      A.ok(r3 && /more than 40 files and folders/.test(r3.detail || ''), 'saying why');
      A.eq(budget.list('v5').snapshots.length, rows5, 'nothing was touched: no pre-restore row');
      A.ok(fs.existsSync(path.join(wt5, 'build', 'o44.js')), 'and build/ is whole');
    }, true);

    // ================= 19. review round 6: a rewind never replaces or deletes what no capture took (trunk d5024f5a did, ok:true) =================
    const refusedUntouched = (store_, aid, r, rowsBefore, pathRe, label) => {
      A.eq(r && r.reason, 'uncaptured_in_path', label + ' is refused (' + JSON.stringify(r) + ')');
      A.ok(r && pathRe.test(r.detail || '') && /Nothing was changed; move it aside, then rewind again/.test(r.detail || ''), 'naming the path, and what to do');
      A.ok(r && Array.isArray(r.paths) && r.paths.length >= 1 && !r.preRestoreId, 'listing it, with no undo row');
      A.eq(store_.list(aid).snapshots.length, rowsBefore, 'nothing was touched: no pre-restore row');
    };
    row('w1', async () => {
      // E2: s0 tracked .env (A); .env was deleted (a snapshot recorded that), then .gitignore listed .env and a new .env (B)
      // was written: no capture took B. reset wrote A over it, and B was in no row
      const aid = 'w1', wt = path.join(ROOT, aid);
      put(path.join(wt, 'app.js'), 'v0\n');
      put(path.join(wt, '.env'), 'KEY=A-fixture\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: '.env A tracked' });
      fs.unlinkSync(path.join(wt, '.env'));
      put(path.join(wt, 'app.js'), 'v1\n');
      await store.snapshot(aid, { runId: 'r', turn: 2, label: 'no .env' });
      put(path.join(wt, '.gitignore'), '.env\n');
      put(path.join(wt, '.env'), 'KEY=B-fixture\n');
      const s2 = await store.snapshot(aid, { runId: 'r', turn: 3, label: 'an ignored .env B' });
      A.eq(s2 ? (await tree(aid, s2.id)) : [], ['.gitignore', 'app.js'], 'fixture: no capture took the new .env');
      const rows = store.list(aid).snapshots.length;
      refusedUntouched(store, aid, await store.restoreDetailed(aid, s0.id), rows, /^"\.env" as it is now is in no restore point \(Git ignores it\), and the restore point holds a file at that path: rewinding would replace it/, 'a rewind that would write the old .env over the ignored new one');
      A.eq(bodyOf(path.join(wt, '.env')), 'KEY=B-fixture\n', 'the new .env is intact');
      A.eq(bodyOf(path.join(wt, 'app.js')), 'v1\n', 'and so is the rest of the work tree');
      fs.renameSync(path.join(wt, '.env'), path.join(wt, '.env.mine'));   // the person moves it aside: their explicit choice
      const again = await store.restoreDetailed(aid, s0.id);
      A.eq(again && again.ok, true, 'once it is moved aside, the rewind goes ahead (' + JSON.stringify(again) + ')');
      A.eq(bodyOf(path.join(wt, '.env')), 'KEY=A-fixture\n', 'writing the old .env');
      A.ok(again && again.preRestoreId && (await tree(aid, again.preRestoreId)).includes('.env.mine'), 'and the moved one, which nothing ignores, is in the undo row (the target lacks it, so reset removed it)');
    });
    row('w2', async () => {
      // E3: the target holds a FILE `build`; build/ is now an ignored folder holding a key. reset deleted the folder with it
      const aid = 'w2', wt = path.join(ROOT, aid);
      put(path.join(wt, 'build'), 'build was a file\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'build is a file' });
      fs.unlinkSync(path.join(wt, 'build'));
      put(path.join(wt, '.gitignore'), 'build/\n*.key\n');
      put(path.join(wt, 'build', 'secret.key'), 'K\n');
      await store.snapshot(aid, { runId: 'r', turn: 2, label: 'an ignored build/' });
      const rows = store.list(aid).snapshots.length;
      refusedUntouched(store, aid, await store.restoreDetailed(aid, s0.id), rows, /^"build" as it is now is in no restore point \(Git ignores it\), and the restore point holds a file at that path: rewinding would delete that folder with all it holds/, 'turning an ignored folder back into a file');
      A.eq(bodyOf(path.join(wt, 'build', 'secret.key')), 'K\n', 'the key is intact');
      // the same through a glob rule, deeper, in a folder the walk enters: out/deep/b.key in an out/ the target holds as a file
      const aid2 = 'w2b', wt2 = path.join(ROOT, aid2);
      put(path.join(wt2, 'out'), 'out was a file\n');
      const t0 = await store.snapshot(aid2, { runId: 'r', turn: 1, label: 'out is a file' });
      fs.unlinkSync(path.join(wt2, 'out'));
      put(path.join(wt2, '.gitignore'), '*.key\n');
      put(path.join(wt2, 'out', 'a.txt'), 'a\n');
      put(path.join(wt2, 'out', 'deep', 'b.key'), 'K2\n');
      await store.snapshot(aid2, { runId: 'r', turn: 2, label: 'out/ holds an ignored key' });
      const rows2 = store.list(aid2).snapshots.length;
      refusedUntouched(store, aid2, await store.restoreDetailed(aid2, t0.id), rows2, /^"out\/deep" as it is now is in no restore point \(Git ignores it\), inside the folder "out", which the restore point holds as a file/, 'turning a folder holding an ignored file back into a file');
      A.eq(bodyOf(path.join(wt2, 'out', 'deep', 'b.key')), 'K2\n', 'that file is intact');
    });
    row('w3', async () => {
      // E4: the target holds a logs/ folder; `logs` is now an ignored FILE. reset deleted it to make the folder
      const aid = 'w3', wt = path.join(ROOT, aid);
      put(path.join(wt, 'logs', 'a.txt'), 'a\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'a logs/ folder' });
      fs.rmSync(path.join(wt, 'logs'), { recursive: true });
      await store.snapshot(aid, { runId: 'r', turn: 2, label: 'no logs' });
      put(path.join(wt, '.gitignore'), 'logs\n');
      put(path.join(wt, 'logs'), 'LOG LINES\n');
      await store.snapshot(aid, { runId: 'r', turn: 3, label: 'an ignored logs file' });
      const rows = store.list(aid).snapshots.length;
      refusedUntouched(store, aid, await store.restoreDetailed(aid, s0.id), rows, /^"logs" as it is now is in no restore point \(Git ignores it\), and the restore point holds a folder at that path: rewinding would delete it/, 'a rewind that would delete an ignored file for a folder');
      A.eq(bodyOf(path.join(wt, 'logs')), 'LOG LINES\n', 'the logs file is intact');
    });
    row('w4', async () => {
      // E5: the target holds a FILE `vendor`; vendor/ is now a clone with a commit of its own and uncommitted work. reset
      // deleted it, its .git with it. And inside a clone: the target holds vendor/lib.c (a plain folder then), the clone's
      // own lib.c has an uncommitted edit, and reset wrote the old one over it
      const aid = 'w4', wt = path.join(ROOT, aid), v = path.join(wt, 'vendor');
      put(path.join(wt, 'app.js'), 'v0\n');
      put(v, 'vendor was a file\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'vendor is a file' });
      fs.unlinkSync(v);
      put(path.join(v, 'lib.c'), 'int x;\n');
      await gitInit(v);
      put(path.join(v, 'wip.c'), 'uncommitted\n');
      const s1 = await store.snapshot(aid, { runId: 'r', turn: 2, label: 'vendor is a clone' });
      A.eq(s1 ? (await tree(aid, s1.id)) : [], ['app.js', 'vendor'], 'fixture: the clone is one gitlink');
      const rows = store.list(aid).snapshots.length;
      refusedUntouched(store, aid, await store.restoreDetailed(aid, s0.id), rows, /^"vendor" as it is now is in no restore point \(it is an embedded Git repository\), and the restore point holds a file at that path: rewinding would delete that folder with all it holds/, 'turning a clone back into a file');
      A.ok(fs.existsSync(path.join(v, '.git', 'HEAD')) && bodyOf(path.join(v, 'wip.c')) === 'uncommitted\n', 'the clone, its history and its uncommitted work are intact');
      const aid2 = 'w4b', wt2 = path.join(ROOT, aid2), v2 = path.join(wt2, 'vendor');
      put(path.join(v2, 'lib.c'), 'old\n');
      const t0 = await store.snapshot(aid2, { runId: 'r', turn: 1, label: 'vendor is a plain folder' });
      fs.rmSync(v2, { recursive: true });
      await store.snapshot(aid2, { runId: 'r', turn: 2, label: 'no vendor' });
      put(path.join(v2, 'lib.c'), 'committed\n');
      await gitInit(v2);
      put(path.join(v2, 'lib.c'), 'uncommitted edit\n');
      await store.snapshot(aid2, { runId: 'r', turn: 3, label: 'vendor is a clone' });
      const rows2 = store.list(aid2).snapshots.length;
      refusedUntouched(store, aid2, await store.restoreDetailed(aid2, t0.id), rows2, /^"vendor\/lib\.c" as it is now is in no restore point \(it is inside the embedded repository "vendor"\), and the restore point holds a file at that path: rewinding would replace it/, 'writing a file over one inside a clone');
      A.eq(bodyOf(path.join(v2, 'lib.c')), 'uncommitted edit\n', 'the clone\'s uncommitted edit is intact');
      // a clone the shadow index records as a gitlink whose .git went away: Git still reads nothing below that gitlink,
      // so no capture takes the files there either
      const aid3 = 'w4c', wt3 = path.join(ROOT, aid3), v3 = path.join(wt3, 'vendor');
      put(v3, 'vendor was a file\n');
      const u0 = await store.snapshot(aid3, { runId: 'r', turn: 1, label: 'vendor is a file' });
      fs.unlinkSync(v3);
      put(path.join(v3, 'lib.c'), 'c\n');
      await gitInit(v3);
      await store.snapshot(aid3, { runId: 'r', turn: 2, label: 'vendor is a clone' });
      fs.rmSync(path.join(v3, '.git'), { recursive: true, force: true });
      put(path.join(v3, 'notes.txt'), 'work no capture took\n');
      const rows3 = store.list(aid3).snapshots.length;
      refusedUntouched(store, aid3, await store.restoreDetailed(aid3, u0.id), rows3, /^"vendor" as it is now is in no restore point \(it is an embedded Git repository\)/, 'turning a recorded gitlink\'s folder back into a file');
      A.eq(bodyOf(path.join(v3, 'notes.txt')), 'work no capture took\n', 'the files below it are intact');
      // the control: the target holds vendor as a gitlink itself, so Git leaves the clone where it stands
      const aid4 = 'w4d', wt4 = path.join(ROOT, aid4), v4 = path.join(wt4, 'vendor');
      put(path.join(wt4, 'app.js'), 'v0\n');
      put(path.join(v4, 'lib.c'), 'c\n');
      await gitInit(v4);
      const g0 = await store.snapshot(aid4, { runId: 'r', turn: 1, label: 'vendor is a gitlink' });
      put(path.join(wt4, 'app.js'), 'v1\n');
      put(path.join(v4, 'wip.c'), 'w\n');
      await store.snapshot(aid4, { runId: 'r', turn: 2, label: 'later' });
      const rg = await store.restoreDetailed(aid4, g0.id);
      A.eq(rg && rg.ok, true, 'a rewind to a point that holds the clone as a gitlink goes ahead (' + JSON.stringify(rg) + ')');
      A.eq(bodyOf(path.join(wt4, 'app.js')) + bodyOf(path.join(v4, 'wip.c')), 'v0\nw\n', 'and leaves the clone\'s work where it is');
    }, true);
    row('w5', async () => {
      // the controls: what a capture takes is no reason to refuse, and what stands at no path the target holds stays
      const aid = 'w5', wt = path.join(ROOT, aid);
      put(path.join(wt, 'out'), 'out was a file\n');
      put(path.join(wt, 'dist', 'keep.txt'), 'kept\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'out is a file' });
      fs.unlinkSync(path.join(wt, 'out'));
      put(path.join(wt, 'out', 'a.txt'), 'a\n');
      fs.mkdirSync(path.join(wt, 'out', 'empty'));
      put(path.join(wt, '.gitignore'), 'dist/\n.env\n');
      put(path.join(wt, 'dist', 'bundle.js'), 'built, ignored\n');
      put(path.join(wt, '.env'), 'KEY=fixture\n');
      const r = await store.restoreDetailed(aid, s0.id);
      A.eq(r && r.ok, true, 'a folder holding only captured files turns back into a file, beside ignored files at no path the target holds (' + JSON.stringify(r) + ')');
      A.eq(bodyOf(path.join(wt, 'out')), 'out was a file\n', 'and rewinds');
      A.ok(r && r.preRestoreId && (await tree(aid, r.preRestoreId)).includes('out/a.txt'), 'out/a.txt is in the undo row');
      A.eq(bodyOf(path.join(wt, 'dist', 'bundle.js')) + bodyOf(path.join(wt, '.env')), 'built, ignored\nKEY=fixture\n', 'the ignored files stay where they are');
      A.eq(bodyOf(path.join(wt, 'dist', 'keep.txt')), 'kept\n', 'beside the tracked file in the ignored folder');
    });
    row('w6', async () => {
      // review 6.2: Git's own repository rule is broader than the walk's looksLikeRepo. A LINKED WORKTREE (its .git a gitfile
      // naming <main>/.git/worktrees/<name>, which holds a commondir) and a folder whose `.git` is a LINK to a repository are
      // embedded repositories to Git (is_nonbare_repository_dir): `add -A` records one gitlink and takes none of their files.
      // Neither was counted, so reset wrote the target's file over a worktree's uncommitted edit, deleted a worktree's
      // folder for a target FILE, and overwrote an edit beside a `.git` link, each ok:true with the edit in no row
      const ident = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
      const main = outside('mainW6', { 'main.c': 'committed in main\n' });
      await gitInit(main);
      const worktreeAt = (dir) => gitRun(ident.concat(['worktree', 'add', '-q', '--detach', dir]), { cwd: main });
      const aid = 'w6', wt = path.join(ROOT, aid), feat = path.join(wt, 'feat');
      put(path.join(wt, 'app.js'), 'v0\n');
      put(path.join(feat, 'main.c'), 'old plain folder\n');
      const s0 = await store.snapshot(aid, { runId: 'r', turn: 1, label: 'feat is a plain folder' });
      fs.rmSync(feat, { recursive: true });
      put(path.join(wt, 'app.js'), 'v1\n');
      await store.snapshot(aid, { runId: 'r', turn: 2, label: 'no feat' });
      await worktreeAt(feat);
      put(path.join(feat, 'main.c'), 'UNCOMMITTED WORKTREE EDIT\n');
      A.ok(/^gitdir: /.test(bodyOf(path.join(feat, '.git')) || ''), 'fixture: feat is a linked worktree, no capture since');
      const rows = store.list(aid).snapshots.length;
      refusedUntouched(store, aid, await store.restoreDetailed(aid, s0.id), rows, /^"feat\/main\.c" as it is now is in no restore point \(it is inside the embedded repository "feat"\), and the restore point holds a file at that path: rewinding would replace it/, 'writing a file over one inside a linked worktree');
      A.eq(bodyOf(path.join(feat, 'main.c')) + bodyOf(path.join(wt, 'app.js')), 'UNCOMMITTED WORKTREE EDIT\nv1\n', 'the worktree\'s uncommitted edit is intact');
      // the target holds a FILE feat/sub; feat/ is now a linked worktree whose sub/ holds the person's notes
      const aid2 = 'w6b', wt2 = path.join(ROOT, aid2), feat2 = path.join(wt2, 'feat');
      put(path.join(feat2, 'sub'), 'sub was a file\n');
      const t0 = await store.snapshot(aid2, { runId: 'r', turn: 1, label: 'feat/sub is a file' });
      fs.rmSync(feat2, { recursive: true });
      put(path.join(wt2, 'app.js'), 'v1\n');
      await store.snapshot(aid2, { runId: 'r', turn: 2, label: 'no feat' });
      await worktreeAt(feat2);
      put(path.join(feat2, 'sub', 'notes.md'), 'WORKTREE NOTES\n');
      const rows2 = store.list(aid2).snapshots.length;
      refusedUntouched(store, aid2, await store.restoreDetailed(aid2, t0.id), rows2, /^"feat\/sub" as it is now is in no restore point \(it is inside the embedded repository "feat"\), and the restore point holds a file at that path: rewinding would delete that folder with all it holds/, 'turning a folder inside a linked worktree back into a file');
      A.eq(bodyOf(path.join(feat2, 'sub', 'notes.md')), 'WORKTREE NOTES\n', 'the notes in it are intact');
      // lib/.git is a link to a repository's git-dir (a fixture folder): an edited lib/file.txt no capture took
      const repo = outside('repoW6', { 'file.txt': 'committed\n' });
      await gitInit(repo);
      const aid3 = 'w6c', wt3 = path.join(ROOT, aid3), lib = path.join(wt3, 'lib');
      put(path.join(wt3, 'app.js'), 'v0\n');
      put(path.join(lib, 'file.txt'), 'old\n');
      const u0 = await store.snapshot(aid3, { runId: 'r', turn: 1, label: 'lib is a plain folder' });
      fs.rmSync(lib, { recursive: true });
      await store.snapshot(aid3, { runId: 'r', turn: 2, label: 'no lib' });
      put(path.join(lib, 'file.txt'), 'UNCOMMITTED EDIT\n');
      link(path.join(repo, '.git'), path.join(lib, '.git'));
      const rows3 = store.list(aid3).snapshots.length;
      refusedUntouched(store, aid3, await store.restoreDetailed(aid3, u0.id), rows3, /^"lib\/file\.txt" as it is now is in no restore point \(it is inside the embedded repository "lib"\), and the restore point holds a file at that path: rewinding would replace it/, 'writing a file over one beside a `.git` link');
      A.eq(bodyOf(path.join(lib, 'file.txt')), 'UNCOMMITTED EDIT\n', 'the edit is intact');
      A.ok(isLink(path.join(lib, '.git')) && fs.existsSync(path.join(repo, '.git', 'HEAD')), 'and so are the link and the repository behind it');
      // the control: a folder holding a `.git` that the shadow index tracks a path below is a plain folder to Git, which
      // captures its files, so the rewind goes ahead and the file it writes over is in the undo row
      const aid4 = 'w6d', wt4 = path.join(ROOT, aid4), lib4 = path.join(wt4, 'lib');
      put(path.join(lib4, 'keep.txt'), 'kept\n');
      put(path.join(lib4, 'old.txt'), 'old\n');
      const g0 = await store.snapshot(aid4, { runId: 'r', turn: 1, label: 'lib holds keep and old' });
      fs.unlinkSync(path.join(lib4, 'old.txt'));
      await store.snapshot(aid4, { runId: 'r', turn: 2, label: 'old.txt deleted' });
      put(path.join(lib4, 'old.txt'), 'NEWER, no capture yet\n');
      link(path.join(repo, '.git'), path.join(lib4, '.git'));
      const rc = await store.restoreDetailed(aid4, g0.id);
      A.eq(rc && rc.ok, true, 'a rewind into a captured folder that now holds a `.git` goes ahead (' + JSON.stringify(rc) + ')');
      A.eq(bodyOf(path.join(lib4, 'old.txt')), 'old\n', 'writing the target\'s file');
      const undone = rc && rc.preRestoreId ? await gitRun(['--git-dir', gitDirOf(aid4), 'show', rc.preRestoreId + ':lib/old.txt']) : null;
      A.eq(undone, 'NEWER, no capture yet\n', 'and the newer one is in the undo row (Git captured it: lib is a plain folder to it)');
      A.ok(isLink(path.join(lib4, '.git')) && fs.existsSync(path.join(repo, '.git', 'HEAD')), 'the `.git` link and the repository behind it stay where they were');
    }, true);
    row('w7', async () => {
      // w7, macOS: the file system folds case as NTFS does, and Git (core.ignorecase) reads a `.GIT` there as the `.git` of
      // an embedded repository, but the store's classifier folds that name on Windows only. Emulated on NTFS: a store
      // whose paths use '/' as the separator, made while process.platform says darwin. Reset wrote the target's file
      // over an uncommitted edit in a clone whose git-dir is spelled .GIT, ok:true, the edit in no row
      if (isWin || process.platform === 'darwin') {
        let mac = null;
        const platform = Object.getOwnPropertyDescriptor(process, 'platform');
        if (isWin) Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
        try { mac = makeCheckpointStore({ fs, pathMod: isWin ? Object.assign(Object.create(path), { sep: '/' }) : path, root: ROOT, runGit, clock, keep: 50 }); }
        finally { if (isWin) Object.defineProperty(process, 'platform', platform); }
        const aid = 'w7', wt = path.join(ROOT, aid), x = path.join(wt, 'x');
        put(path.join(wt, 'app.js'), 'v0\n');
        put(path.join(x, 'main.c'), 'old plain folder\n');
        const s0 = await mac.snapshot(aid, { runId: 'r', turn: 1, label: 'x is a plain folder' });
        fs.rmSync(x, { recursive: true });
        put(path.join(wt, 'app.js'), 'v1\n');
        await mac.snapshot(aid, { runId: 'r', turn: 2, label: 'no x' });
        put(path.join(x, 'main.c'), 'committed\n');
        await gitInit(x);
        fs.renameSync(path.join(x, '.git'), path.join(x, '.GIT'));
        put(path.join(x, 'main.c'), 'UNCOMMITTED EDIT\n');
        A.ok(fs.readdirSync(x).includes('.GIT'), 'fixture: x is a clone whose git-dir is spelled .GIT, no capture since');
        const rows = mac.list(aid).snapshots.length;
        refusedUntouched(mac, aid, await mac.restoreDetailed(aid, s0.id), rows, /^"x\/main\.c" as it is now is in no restore point \(it is inside the embedded repository "x"\), and the restore point holds a file at that path: rewinding would replace it/, 'on macOS, writing a file over one inside a clone whose `.git` is spelled `.GIT`');
        A.eq(bodyOf(path.join(x, 'main.c')) + bodyOf(path.join(wt, 'app.js')), 'UNCOMMITTED EDIT\nv1\n', 'the clone\'s uncommitted edit is intact');
      } else console.log('[skip] macOS `.GIT`: a case-sensitive file system reads it as a plain folder, as Git does here');
    });
    row('w7b', async () => {
      // review minors: the rest of a `.GIT`, emulated on NTFS as w7 is (a store whose paths use '/' as the separator, made
      // while process.platform says darwin or linux)
      const storeAs = (platform) => {
        const was = Object.getOwnPropertyDescriptor(process, 'platform'), other = process.platform !== platform;
        if (other) Object.defineProperty(process, 'platform', { value: platform, configurable: true });
        try { return makeCheckpointStore({ fs, pathMod: isWin ? Object.assign(Object.create(path), { sep: '/' }) : path, root: ROOT, runGit, clock, keep: 50 }); }
        finally { if (other) Object.defineProperty(process, 'platform', was); }
      };
      if (isWin || process.platform === 'darwin') {
        // w7b, macOS: a `.GIT` in a folder the shadow index tracks files below is no repository to Git, which skips it as it
        // skips a `.git` (core.ignorecase), so no capture takes it, and only the walk's gitFolders (a folder) and gitFiles
        // (a file) name it. The target holds a FILE d; d/ now holds a captured kept.txt beside a plain .GIT folder, then
        // beside a .GIT file that is no gitfile. No row reached those two lists: without them reset deleted d with its .GIT,
        // ok:true, the .GIT in no row
        const mac = storeAs('darwin');
        for (const [aid, at, body, what] of [['w7b', ['.GIT', 'notes.txt'], 'NOTES, in no capture\n', 'a plain `.GIT` folder'],
          ['w7c', ['.GIT'], 'not a gitfile\n', 'a `.GIT` file that is no gitfile']]) {
          const wt = path.join(ROOT, aid), d = path.join(wt, 'd');
          put(path.join(wt, 'app.js'), 'v0\n');
          put(d, 'd was a file\n');
          const s0 = await mac.snapshot(aid, { runId: 'r', turn: 1, label: 'd is a file' });
          fs.unlinkSync(d);
          put(path.join(d, 'kept.txt'), 'kept\n');
          put(path.join(d, ...at), body);
          const s1 = await mac.snapshot(aid, { runId: 'r', turn: 2, label: 'd is a folder' });
          const held = s1 && s1.created ? (await tree(aid, s1.id)) : [];
          A.ok(held.includes('d/kept.txt') && !held.some((p) => /^d\/\.git(\/|$)/i.test(p)), 'fixture: the capture took d/kept.txt, and Git skipped d/.GIT (' + what + ')');
          const rows = mac.list(aid).snapshots.length;
          refusedUntouched(mac, aid, await mac.restoreDetailed(aid, s0.id), rows, /^"d\/\.GIT" as it is now is in no restore point \(it is Git's own data\), inside the folder "d", which the restore point holds as a file: rewinding would delete that folder with it/, 'on macOS, turning a folder that holds ' + what + ' back into a file');
          A.eq(bodyOf(path.join(d, ...at)) + bodyOf(path.join(d, 'kept.txt')), body + 'kept\n', 'd/.GIT and d/kept.txt are intact');
        }
        // w7d-w7f, Linux on a case-insensitive mount (WSL's /mnt/c, ext4 casefold, vfat/exFAT): Git asks the file system for
        // x/.git (is_nonbare_repository_dir), so a clone whose git-dir is spelled .GIT, a linked worktree whose gitfile is,
        // and a `.GIT` link to a repository are each one gitlink to `add -A`, whatever core.ignorecase says. The walk
        // counted a `.GIT` on macOS only, so reset wrote the target's x/main.c over the uncommitted edit, ok:true, the
        // edit in no row (fd7ee0f0 and trunk d5024f5a did the same)
        const lin = storeAs('linux');
        const ident = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
        const main = outside('mainW7', { 'main.c': 'committed in main\n' });
        await gitInit(main);
        const repo = outside('repoW7', { 'main.c': 'committed\n' });
        await gitInit(repo);
        const shapes = [
          ['w7d', 'a clone whose git-dir is spelled .GIT', async (x) => { put(path.join(x, 'main.c'), 'committed\n'); await gitInit(x); fs.renameSync(path.join(x, '.git'), path.join(x, '.GIT')); }],
          ['w7e', 'a linked worktree whose gitfile is spelled .GIT', async (x) => {
            await gitRun(ident.concat(['worktree', 'add', '-q', '--detach', x]), { cwd: main });
            fs.renameSync(path.join(x, '.git'), path.join(x, '.GIT'));
          }],
          ['w7f', 'a folder whose `.GIT` is a link to a repository', (x) => { fs.mkdirSync(x, { recursive: true }); link(path.join(repo, '.git'), path.join(x, '.GIT')); }],
        ];
        for (const [aid, what, make] of shapes) {
          const wt = path.join(ROOT, aid), x = path.join(wt, 'x');
          put(path.join(wt, 'app.js'), 'v0\n');
          put(path.join(x, 'main.c'), 'old plain folder\n');
          const s0 = await lin.snapshot(aid, { runId: 'r', turn: 1, label: 'x is a plain folder' });
          fs.rmSync(x, { recursive: true });
          put(path.join(wt, 'app.js'), 'v1\n');
          await lin.snapshot(aid, { runId: 'r', turn: 2, label: 'no x' });
          await make(x);
          put(path.join(x, 'main.c'), 'UNCOMMITTED EDIT\n');
          A.ok(fs.readdirSync(x).includes('.GIT') && !fs.readdirSync(x).includes('.git'), 'fixture: x is ' + what + ', no capture since');
          const rows = lin.list(aid).snapshots.length;
          refusedUntouched(lin, aid, await lin.restoreDetailed(aid, s0.id), rows, /^"x\/main\.c" as it is now is in no restore point \(it is inside the embedded repository "x"\), and the restore point holds a file at that path: rewinding would replace it/, 'on Linux over a case-insensitive mount, writing a file over one inside ' + what);
          A.eq(bodyOf(path.join(x, 'main.c')) + bodyOf(path.join(wt, 'app.js')), 'UNCOMMITTED EDIT\nv1\n', 'the uncommitted edit is intact');
        }
        A.ok(isLink(path.join(ROOT, 'w7f', 'x', '.GIT')) && fs.existsSync(path.join(repo, '.git', 'HEAD')), 'the `.GIT` link and the repository behind it stay where they were');
      } else console.log('[skip] `.GIT` on macOS and on a case-insensitive Linux mount: this file system is case-sensitive, and Git refuses to add a `.GIT` path here');
    }, true);
    await runRows(first.concat(rows), () => ({}));
    {
      // this file ran 66-79 s on a quiet box before row 20, then up to 477 s one row at a time with the CPU near 100%; its
      // rows run four at a time since undo review 6 (slow.list says what it takes, under what load and when), still past
      // test/slow.list's 40 s rule; listed there, a gate gives it 600 s, not 120 s
      const slow = fs.readFileSync(path.join(__dirname, 'slow.list'), 'utf8').split(/\r?\n/).map((s) => s.trim());
      A.ok(slow.includes('test/checkpoint-links.test.js'), 'this step is declared in test/slow.list (every row makes real snapshots and rewinds)');
    }
    {
      const route = sidecarTopLevelFunction('handleCheckpointRestore');
      A.ok(/out\.reason === 'uncaptured_in_path' \|\| out\.reason === 'uncaptured_check_failed'\)\) return json\(409, \{ error: 'restore refused: ' \+ String\(out\.detail/.test(route),
        'the restore route answers the refusal 409 in the store\'s own words (it would have fallen through to "no such snapshot")');
      A.ok(/out\.reason === 'git_failed'\) return json\(500, \{ error: 'restore did not complete' \+ \(out\.detail \? ' \(' \+ out\.detail \+ '\)' : ''\)/.test(route),
        'and an incomplete rewind names what it could not remove');
    }
  } finally {
    for (const l of links.slice().reverse()) {
      let present = true;
      try { fs.lstatSync(l); } catch (_) { present = false; }
      if (!present) { links.splice(links.indexOf(l), 1); continue; }   // a link a failing rewind removed: nothing left to unlink
      try { unlinkLink(l); } catch (e) { console.log('[cleanup] could not remove link ' + l + ': ' + e.message); }
    }
    if (!links.length) { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) {} }
    else console.log('[cleanup] left ' + BASE + ' in place: links remain');
  }
  A.report('checkpoint-links.test');
})().catch((e) => { console.log('FAIL: checkpoint-links.test threw — ' + (e && e.stack || e)); process.exit(1); });
