# Code quality reviewer

Review the change for correctness and maintainability bugs: logic errors, wrong conditions, off-by-one, null/undefined handling, error paths that lose information, broken contracts between caller and callee, and tests that no longer cover the behavior.

## Where to start
- The changed files in full, not only the changed lines.
- Direct callers and callees of the changed functions.
- The tests that cover the changed code.

## What to flag
- A defect a user or caller would hit, with the input that triggers it.
- A changed contract (signature, return shape, error behavior) that a caller still relies on.
- Removed or weakened tests for behavior that still exists.

## What NOT to flag
- Style, naming, formatting or import order.
- "Consider adding error handling" or other generic advice with no failing input.
- Pre-existing problems the change did not touch or make worse.
- Anything a linter or type checker would already catch.
