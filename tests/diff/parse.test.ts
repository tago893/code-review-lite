import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DiffParseError, parseUnifiedDiff } from "../../src/diff/parse.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/diffs/${name}`, import.meta.url), "utf8");

const only = (text: string) => {
  const entries = parseUnifiedDiff(text);
  expect(entries).toHaveLength(1);
  return entries[0]!;
};

describe("parseUnifiedDiff: input edge cases", () => {
  it.each(["", "\n", "  \n\n"])("returns [] for empty or whitespace-only input %j", (text) => {
    expect(parseUnifiedDiff(text)).toEqual([]);
  });

  it("returns frozen entries and arrays", () => {
    const entry = only(fixture("modify-multi-hunk.diff"));
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.addedLines)).toBe(true);
    expect(Object.isFrozen(entry.addedLineNumbers)).toBe(true);
  });
});

describe("parseUnifiedDiff: line mapping", () => {
  it("maps added lines to new-file numbers and removed lines to old-file numbers across hunks", () => {
    const entry = only(fixture("modify-multi-hunk.diff"));
    expect(entry.status).toBe("modified");
    expect(entry.oldPath).toBe("src/app.ts");
    expect(entry.newPath).toBe("src/app.ts");
    expect(entry.removedLines).toEqual(["line 3", "line 4", "line 10", "line 28"]);
    expect(entry.removedLineNumbers).toEqual([3, 4, 10, 28]);
    expect(entry.addedLines).toEqual(["line 3 CHANGED", "line 10 CHANGED", "line 10b NEW", "line 28 CHANGED"]);
    expect(entry.addedLineNumbers).toEqual([3, 9, 10, 28]);
  });

  it("keeps the raw patch for just that file", () => {
    const entries = parseUnifiedDiff(fixture("all-changes.diff"));
    for (const entry of entries) {
      expect(entry.patch.startsWith("diff --git ")).toBe(true);
      expect(entry.patch.match(/^diff --git /gm)).toHaveLength(1);
    }
  });

  it("treats content that looks like file headers as content inside a hunk", () => {
    const text = [
      "diff --git a/q.sql b/q.sql",
      "index 1..2 100644",
      "--- a/q.sql",
      "+++ b/q.sql",
      "@@ -1,2 +1,2 @@",
      "--- sql comment",
      "+++ sql comment 2",
      " keep",
      "",
    ].join("\n");
    const entry = only(text);
    expect(entry.removedLines).toEqual(["-- sql comment"]);
    expect(entry.addedLines).toEqual(["++ sql comment 2"]);
    expect(entry.removedLineNumbers).toEqual([1]);
    expect(entry.addedLineNumbers).toEqual([1]);
  });

  it("defaults omitted hunk counts to 1", () => {
    const text = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -7 +7 @@\n-old\n+new\n";
    const entry = only(text);
    expect(entry.removedLineNumbers).toEqual([7]);
    expect(entry.addedLineNumbers).toEqual([7]);
  });

  it("does not count the no-newline marker as a line", () => {
    const entry = only(fixture("no-newline.diff"));
    expect(entry.removedLines).toEqual(["c"]);
    expect(entry.addedLines).toEqual(["CHANGED"]);
    expect(entry.removedLineNumbers).toEqual([3]);
    expect(entry.addedLineNumbers).toEqual([3]);
  });

  it("strips CR from line content, for CRLF files and for a CRLF-converted diff alike", () => {
    const raw = fixture("crlf.diff");
    for (const text of [raw, raw.replace(/\r?\n/g, "\r\n")]) {
      const entry = only(text);
      expect(entry.removedLines).toEqual(["two"]);
      expect(entry.addedLines).toEqual(["TWO"]);
      expect(entry.addedLineNumbers).toEqual([2]);
    }
  });
});

describe("parseUnifiedDiff: file kinds", () => {
  it("parses an added file and an added empty file", () => {
    const [added, empty] = parseUnifiedDiff(fixture("add.diff"));
    expect(added).toMatchObject({ status: "added", newPath: "added.txt", oldPath: "added.txt" });
    expect(added!.addedLines).toEqual(["added 1", "added 2"]);
    expect(added!.addedLineNumbers).toEqual([1, 2]);
    expect(empty).toMatchObject({ status: "added", newPath: "empty-new.txt", isBinary: false });
    expect(empty!.addedLines).toEqual([]);
  });

  it("parses a deleted file with old-file line numbers", () => {
    const entry = only(fixture("delete.diff"));
    expect(entry).toMatchObject({ status: "deleted", oldPath: "deleted.txt", newPath: "deleted.txt" });
    expect(entry.removedLines).toEqual(["gone 1", "gone 2", "gone 3"]);
    expect(entry.removedLineNumbers).toEqual([1, 2, 3]);
    expect(entry.addedLines).toEqual([]);
  });

  it("parses a pure rename with no lines", () => {
    const entry = only(fixture("rename-only.diff"));
    expect(entry).toMatchObject({ status: "renamed", isRename: true, oldPath: "old-name.txt", newPath: "new-name.txt" });
    expect(entry.addedLines).toEqual([]);
    expect(entry.removedLines).toEqual([]);
  });

  it("parses a rename with edits, mapping old and new paths and lines", () => {
    const entry = only(fixture("rename-edit.diff"));
    expect(entry).toMatchObject({
      status: "renamed",
      isRename: true,
      oldPath: "rename-edit-old.txt",
      newPath: "rename-edit-new.txt",
    });
    expect(entry.removedLines).toEqual(["edit me 5"]);
    expect(entry.removedLineNumbers).toEqual([5]);
    expect(entry.addedLines).toEqual(["edit me 5 EDITED"]);
    expect(entry.addedLineNumbers).toEqual([5]);
  });

  it("flags binary files (modified and added) without lines", () => {
    const [modified, added] = parseUnifiedDiff(fixture("binary.diff"));
    expect(modified).toMatchObject({ isBinary: true, status: "modified", newPath: "bin.dat" });
    expect(added).toMatchObject({ isBinary: true, status: "added", newPath: "newbin.dat" });
    expect(modified!.addedLines).toEqual([]);
    expect(added!.removedLines).toEqual([]);
  });

  it("parses a mode-only change as modified with no lines", () => {
    const entry = only(fixture("mode-change.diff"));
    expect(entry).toMatchObject({ status: "modified", newPath: "script.sh", isBinary: false, isRename: false });
    expect(entry.addedLines).toEqual([]);
  });

  it("parses a git binary patch block as binary", () => {
    const text = [
      "diff --git a/b.bin b/b.bin",
      "index 1..2 100644",
      "GIT binary patch",
      "literal 4",
      "Lc$@x400000",
      "",
      "literal 0",
      "HcmV?d00001",
      "",
    ].join("\n");
    expect(only(text)).toMatchObject({ isBinary: true, newPath: "b.bin" });
  });
});

describe("parseUnifiedDiff: paths", () => {
  it("handles spaces and strips the trailing tab git adds to such names", () => {
    const entry = only(fixture("spaces.diff"));
    expect(entry.oldPath).toBe("dir with space/file name.txt");
    expect(entry.newPath).toBe("dir with space/file name.txt");
    expect(entry.addedLineNumbers).toEqual([9]);
  });

  it("decodes C-quoted UTF-8 octal escapes", () => {
    expect(only(fixture("unicode-path.diff")).newPath).toBe("naïve.txt");
  });

  it("decodes quoted tab, quote and backslash", () => {
    const paths = parseUnifiedDiff(fixture("special-chars.diff")).map((entry) => entry.newPath);
    expect(paths).toEqual(["back\\slash.txt", 'quote"d.txt', "tab\there.txt"]);
  });

  it("parses a whole multi-file diff in order", () => {
    const entries = parseUnifiedDiff(fixture("all-changes.diff"));
    expect(entries).toHaveLength(13);
    expect(entries.filter((entry) => entry.isRename)).toHaveLength(2);
  });
});

describe("parseUnifiedDiff: malformed and unsupported input fails loudly", () => {
  const header = "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n";

  it("rejects text with no diff header", () => {
    expect(() => parseUnifiedDiff("hello world\n")).toThrow(DiffParseError);
    expect(() => parseUnifiedDiff("hello world\n")).toThrow(/diff --git/);
  });

  it("rejects content before the first header, with its line number", () => {
    try {
      parseUnifiedDiff("From abc Mon\nSubject: x\n\n" + header + "@@ -1 +1 @@\n-a\n+b\n");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DiffParseError);
      expect((error as DiffParseError).line).toBe(1);
    }
  });

  it("rejects a truncated hunk", () => {
    expect(() => parseUnifiedDiff(header + "@@ -1,3 +1,3 @@\n a\n")).toThrow(/ended before the hunk/);
  });

  it("rejects a malformed hunk header", () => {
    expect(() => parseUnifiedDiff(header + "@@ nonsense @@\n")).toThrow(/hunk header/);
  });

  it("rejects an invalid line prefix inside a hunk", () => {
    expect(() => parseUnifiedDiff(header + "@@ -1,2 +1,2 @@\n a\n?bad\n")).toThrow(/prefix/);
  });

  it("rejects combined diffs as unsupported", () => {
    expect(() => parseUnifiedDiff("diff --cc x\nindex 1,2..3\n")).toThrow(/unsupported/i);
    expect(() => parseUnifiedDiff(header + "@@@ -1,1 -1,1 +1,1 @@@\n")).toThrow(/unsupported/i);
  });

  it("rejects copies as unsupported", () => {
    const text = "diff --git a/x b/y\nsimilarity index 100%\ncopy from x\ncopy to y\n";
    expect(() => parseUnifiedDiff(text)).toThrow(/unsupported/i);
  });

  it("rejects diffs made without the a/ b/ prefixes", () => {
    expect(() => parseUnifiedDiff("diff --git x y\n--- x\n+++ y\n@@ -1 +1 @@\n-a\n+b\n")).toThrow(/a\/ and b\//);
  });

  it("rejects an unknown header line", () => {
    expect(() => parseUnifiedDiff("diff --git a/x b/x\nweird header\n")).toThrow(/unrecognised/i);
  });

  it("rejects extra lines after a hunk is complete", () => {
    expect(() => parseUnifiedDiff(header + "@@ -1 +1 @@\n-a\n+b\n+extra\n")).toThrow(DiffParseError);
  });
});
