# Reviewing a pull request with several commits

What the reviewer is given, and which guarantees are tested (`tests/multicommit/`, `tests/lean/provenance.test.ts`).
These tests check data preparation only. They do not show that a model reasons correctly about it.

## What is reviewed

The **net change from the review base to the final head**.

- The review base is `git merge-base <requested base> <head>`. When the requested base is an ancestor of the head (the
  usual case, and every benchmark so far) it is the requested base itself, so the diff is exactly the old `base..head`
  diff. When the target branch has moved on since the branch point, the merge base is used, so commits that landed only
  on the target branch are not shown as changes the pull request made. Unrelated histories, or a shallow clone that lacks the branch point, are refused (`no_merge_base`) rather than guessed at.
- Intermediate commits matter only through the final state. A bug introduced and then fixed does not appear in the diff or
  in the files; a bug introduced early and still present does. A pull request whose commits cancel out leaves no diff, and
  the lean reviewer then completes with no findings and makes no model call.
- The files the reviewer reads are the checked-out final head, exactly (HEAD must be the head SHA and the tree clean).
- Renames are followed (`--find-renames`) and the diff format is fixed (`a/` `b/` prefixes), so a repository's own
  `diff.renames` / `diff.noprefix` settings cannot change what the reviewer sees or break the parser.
- Unchanged files are in the snapshot and reachable with the four read-only tools, so a caller of a changed function
  can be found and read. Nothing yet tells the reviewer which unchanged files are affected; that is repository impact
  discovery, a later stage.

## What is recorded

`plan.json` in the review context carries `baseSha` (the merge base), `requestedBaseSha`, `headSha` and `commitShas`
(oldest first, at most 1000). Commit messages are never written there or anywhere the reviewer can read: they are untrusted text.
The reviewer's header line still shows only the range; its input is unchanged for ordinary pull requests.

## Run provenance (lean reviewer)

New `lean-findings.json` files carry a `provenance` block: reviewer commit and a dirty flag, the model, the category, a
hash of the exact prompt text, a hash of the run settings and tool definitions, the reviewed base and head, the requested
base and the commit count. The reviewer commit cannot be read inside the container (no `.git`), so the launcher supplies it:

    source experiments/lean/reviewer-env.sh     # sets CRA_REVIEWER_COMMIT and CRA_REVIEWER_DIRTY
    bash docker/run.sh ...

A value that was not supplied is `null`. Historical artifacts are not rewritten and have no provenance block.

## Plan dispositions in the lean reviewer

`skip_clean` (nothing to review) completes with no findings and no model call. `manual_review` (changes nobody can
analyse, such as a lockfile-only change) is incomplete with reason `manual_review_required`, never a clean result.
These are the rules the original pipeline already used.
