#!/usr/bin/env bash
# Source this before docker/run.sh so a lean run records which reviewer code produced it:
#   source experiments/lean/reviewer-env.sh
# CRA_REVIEWER_DIRTY is 1 when tracked code that runs in the container (src, experiments, prompts, docker, package files)
# has uncommitted changes, so the commit alone would not identify it. Nothing is guessed: if git is unavailable, nothing is set.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if commit="$(git -C "$root" rev-parse HEAD 2>/dev/null)"; then
  export CRA_REVIEWER_COMMIT="$commit"
  if [ -n "$(git -C "$root" status --porcelain --untracked-files=no -- src experiments prompts docker package.json package-lock.json 2>/dev/null)" ]; then export CRA_REVIEWER_DIRTY=1; else export CRA_REVIEWER_DIRTY=0; fi
else
  unset CRA_REVIEWER_COMMIT CRA_REVIEWER_DIRTY
fi
