# Evaluation fixtures

Real historical artifacts, copied byte for byte, used to test the scorer. None contain benchmark labels or ground truth;
they are what the reviewer produced.

| Folder | Original location | What it is |
|---|---|---|
| `legacy-case001-run1` | `agents_projects/cra-runs/case-001` | Legacy OpenCode review of Event Booking Case 001, incomplete (step limit) |
| `legacy-case001-run2` | `agents_projects/cra-runs/case-001-run2` | Same, incomplete (model context overflow) |
| `legacy-case001-run3` | `agents_projects/cra-runs/case-001-run3` | Same, incomplete (model context overflow) |
| `lean-case001-attempt1` | `C:\Users\varun\cra-runs\case001-lean` | Lean reviewer, Case 001, incomplete (HTTP 400 tool_use_failed); predates the one-time recovery |
| `lean-case001-attempt2` | `C:\Users\varun\cra-runs\case001-lean2` | Lean reviewer, Case 001, incomplete (HTTP 429 rate limit) |
| `demo-sqli` | `docs/assets/cra-demo-evidence.json` | Recorded complete SQL-injection demo (no benchmark label exists for it) |

`proxy.log`, `stdout.txt` and `stderr.txt` of the original runs are not copied; the scorer does not read them.
