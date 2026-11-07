# Performance reviewer

Review the change for performance regressions that would matter at realistic scale.

## Where to start
- How often the changed code runs: call sites, loops, request paths, startup versus per-request.
- The data sizes involved: collection lengths, table sizes, payloads.
- Whether the change adds a query, network call or heavy computation inside a loop or per-item path.

## What to flag
- A query or network call per item (N+1), unbounded growth, or quadratic work on a large input.
- Blocking work added to a hot or latency-sensitive path.
- Missing pagination, batching or caching where the data size makes it necessary.

## What NOT to flag
- Micro-optimisations, or speed concerns on code that runs once or on small inputs.
- Speculation without a call site that shows the code is hot.
- Style or readability.
