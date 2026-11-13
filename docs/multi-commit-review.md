# Reviewing a pull request with several commits

What the reviewer is given, and which guarantees are tested (`tests/multicommit/`, `tests/lean/provenance.test.ts`).
These tests check data preparation only. They do not show that a model reasons correctly about it.

## What is reviewed

The **net change from the review base to the final head**.

- The review base is `git merge-base <requested base> <head>`. When the requested base is an ancestor of the head (the
  usual case, and every benchmark so far) it is the requested base itself, so the diff is exactly the old `base..head`
  diff. When the target branch has moved on since the branch point, the merge base is used, so commits that landed only
  on the target branch are not shown as changes the pull request made. Unrelated histories, or a shallow clone that lacks the branch point, are refused (`no_merge_base`) rather than guessed at.
- A head that is behind the requested base (for example base and head given the wrong way round) is refused
  (`head_behind_base`): its net change is empty and would otherwise read as a clean review. Asking for base = head is
  allowed and has nothing to review.
- Intermediate commits matter only through the final state. A bug introduced and then fixed does not appear in the diff or
  in the files; a bug introduced early and still present does. A pull request whose commits cancel out leaves no diff, and
  the lean reviewer then completes with no findings and makes no model call.
- The files the reviewer reads are the checked-out final head, exactly (HEAD must be the head SHA and the tree clean).
- Renames are followed (`--find-renames -l1000`) and the diff format is fixed (`a/` `b/` prefixes, 3 lines of context),
  so a repository's own `diff.renames`, `diff.renameLimit`, `diff.noprefix` or `diff.context` settings cannot change what
  the reviewer sees or break the parser.
- Unchanged files are in the snapshot and reachable with the four read-only tools, so a caller of a changed function
  can be found and read. Nothing yet tells the reviewer which unchanged files are affected; that is repository impact
  discovery, a later stage.

## What is recorded

`plan.json` in the review context carries `baseSha` (the merge base), `requestedBaseSha`, `headSha`, `commitShas`
(oldest first, capped at the newest 1000) and `commitCount` (the true number, even when the list is capped). Commit
messages are never written there or anywhere the reviewer can read: they are untrusted text.
The reviewer's header line still shows only the range; its input is unchanged for ordinary pull requests.

## Run provenance (lean reviewer)

New `lean-findings.json` files carry a `provenance` block: reviewer commit and a dirty flag, the model, the category, a
hash of the exact prompt text, a hash of the run settings and tool definitions, the reviewed base and head, the requested
base and the commit count. The reviewer commit cannot be read inside the container (no `.git`), so the launcher supplies it:

    source experiments/lean/reviewer-env.sh     # sets CRA_REVIEWER_COMMIT and CRA_REVIEWER_DIRTY
    bash docker/run.sh ...

A value that was not supplied is `null`. Historical artifacts are not rewritten and have no provenance block.

## Plan dispositions in the lean reviewer

`skip_clean` (nothing to review) completes with no findings and no model call, and carries reason `nothing_to_review`
so the evaluator can tell it apart from a review in which a model looked and found nothing. `manual_review` (changes
nobody can analyse, such as a lockfile-only change) is incomplete with reason `manual_review_required`, never a clean
result.

What counts as "nothing to review" is deliberately narrow: no net change, pure renames, or documentation only
(`.md`, `.mdx`, `.rst`, `.adoc`, and conventional names such as `LICENSE` or `README.txt`). `.txt` files in general are
reviewed (`requirements.txt`, `CMakeLists.txt` are code), and so is markdown that coding agents or CI read as
instructions (`AGENTS.md`, `CLAUDE.md`, `SKILL.md`, anything under `.github/`, `.claude/`, `.cursor/`, `.windsurf/`...).
A file carrying an `@generated` marker is still kept away from the model, but it can never make a change look clean on
its own: the marker is a comment anyone can write. Every lean result lists such files in `unreviewed` (with binary
files, lockfiles and bundled assets), so a complete review never silently vouches for them.

The evaluator scores a `nothing_to_review` result as a miss on a buggy case and as `not_scored` (not a clean pass) on a
clean one: no model looked, so it says nothing about false positives.
