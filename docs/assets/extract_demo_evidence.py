"""Builds docs/assets/cra-demo-evidence.json from ONE recorded lean review (its trace, findings and proxy request log).

Nothing is invented: tool names, arguments, timings, byte counts and the finding come straight from the recorded files.
Usage: python docs/assets/extract_demo_evidence.py <run-dir> <fixture-repo> <base> <head> <out.json>
The run directory must hold lean-trace.jsonl, lean-findings.json and requests.jsonl (the proxy's body log, which is only
enabled for the synthetic fixture). The body log itself is never published; only the tool arguments and notes are copied.
"""
import json, subprocess, sys
from pathlib import Path

run, repo, base, head, out = (Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], Path(sys.argv[5]))
trace = [json.loads(l) for l in (run / "lean-trace.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
result = json.loads((run / "lean-findings.json").read_text(encoding="utf-8"))
bodies = [json.loads(json.loads(l)["body"]) for l in (run / "requests.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]

investigation = [b for b in bodies if "tools" in b]
structured = [b for b in bodies if "response_format" in b]
last = investigation[-1]["messages"]
calls = [c["function"] for m in last if m.get("role") == "assistant" for c in m.get("tool_calls", [])]
notes = next(m["content"] for m in structured[-1]["messages"] if m["role"] == "user")

tools = [e for e in trace if e["event"] == "tool"]
assert len(calls) == len(tools), (len(calls), len(tools))
events = [{"t": e["t"], "tool": e["tool"], "args": json.loads(c["arguments"]), "status": e["status"], "bytes": e["bytes"]}
          for e, c in zip(tools, calls)]
assert all(e["tool"] == c["name"] for e, c in zip(tools, calls))
diff = subprocess.run(["git", "-C", repo, "diff", "--no-color", base, head], capture_output=True, text=True, encoding="utf-8", check=True).stdout
end = next(e for e in trace if e["event"] == "end")
requests = sum(1 for e in trace if e["event"] == "request") + sum(1 for e in trace if e["event"] == "structured")
f = result["findings"][0]

evidence = {
    "model": "openai/gpt-oss-120b", "base": base[:7], "head": head[:7], "diff": diff,
    "tool_events": events, "notes": notes,
    "finding": {k: f[k] for k in ("severity", "category", "file", "line", "evidence", "claim", "path")},
    "stats": {"status": result["status"], "ms": end["ms"], "model_requests": requests, "tool_calls": len(events),
              "investigation_tokens_in": result["tokensIn"], "investigation_tokens_out": result["tokensOut"],
              "peak_request_bytes": max(e["bytes"] for e in trace if e["event"] == "request"),
              "citations_verified": next(e for e in trace if e["event"] == "verified")["findings"]},
}
text = json.dumps(evidence, indent=2, ensure_ascii=False)
for forbidden in ("gsk_", "C:\\", "/c/Users", "varun"):
    assert forbidden not in text, forbidden
out.write_text(text + "\n", encoding="utf-8")
print("tool calls:", [(e["tool"], e["args"]) for e in events]); print(evidence["stats"])
