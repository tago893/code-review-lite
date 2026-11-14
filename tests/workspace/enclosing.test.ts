import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { enclosingFunction, isSupportedSource } from "../../src/workspace/enclosing.js";

const FIXTURE = join(__dirname, "..", "fixtures", "change-map", "case001");
const load = (path: string): string[] => readFileSync(join(FIXTURE, path), "utf8").split(/\r?\n/);
const hold = load("app/services/hold_service.py");
const booking = load("app/services/booking_service.py");

describe("enclosingFunction (Python, Case 001)", () => {
  it("finds the method a line sits in", () => {
    expect(enclosingFunction("app/services/hold_service.py", hold, 97)).toEqual({ name: "get_hold", startLine: 90, endLine: 102 });
  });
  it("finds the method from its def line", () => {
    expect(enclosingFunction("app/services/hold_service.py", hold, 90)).toEqual({ name: "get_hold", startLine: 90, endLine: 102 });
  });
  it("finds a module-level function", () => {
    expect(enclosingFunction("app/services/hold_service.py", hold, 124)).toEqual({ name: "_require_active", startLine: 123, endLine: 127 });
  });
  it("finds a method in another file", () => {
    expect(enclosingFunction("app/services/booking_service.py", booking, 29)).toEqual({ name: "confirm", startLine: 28, endLine: 51 });
  });
  it("returns undefined for a module-level import", () => {
    expect(enclosingFunction("app/services/hold_service.py", hold, 3)).toBeUndefined();
  });
  it("gives the same result for CRLF input", () => {
    const crlf = booking.join("\r\n").split(/\r?\n/);
    expect(enclosingFunction("app/services/booking_service.py", crlf, 29)).toEqual({ name: "confirm", startLine: 28, endLine: 51 });
  });
});

describe("enclosingFunction (Python, inline)", () => {
  const nested = ["def outer():", "    def inner():", "        a = 1", "    b = 2", "    return b", "", "x = 1"];
  it("returns the inner function for a line in it", () => {
    expect(enclosingFunction("a.py", nested, 3)).toEqual({ name: "inner", startLine: 2, endLine: 3 });
  });
  it("returns the outer function after the inner one ends", () => {
    expect(enclosingFunction("a.py", nested, 4)).toEqual({ name: "outer", startLine: 1, endLine: 5 });
  });
  it("handles a decorator and a multi-line signature", () => {
    const src = ['@app.get("/x")', "def handler(", "    a: int,", ") -> dict:", "    return a"];
    expect(enclosingFunction("a.py", src, 5)).toEqual({ name: "handler", startLine: 2, endLine: 5 });
    expect(enclosingFunction("a.py", src, 3)).toEqual({ name: "handler", startLine: 2, endLine: 5 });
  });
});

describe("enclosingFunction (brace languages)", () => {
  it("finds a TS class method", () => {
    const src = ["export class A {", "  find(id: string): User {", "    return db.get(id);", "  }", "}"];
    expect(enclosingFunction("a.ts", src, 3)).toEqual({ name: "find", startLine: 2, endLine: 4 });
  });
  it("finds a TS arrow function", () => {
    const src = ["const handler = (a: number) => {", "  return a + 1;", "};", "const z = 1;"];
    expect(enclosingFunction("a.ts", src, 2)).toEqual({ name: "handler", startLine: 1, endLine: 3 });
    expect(enclosingFunction("a.ts", src, 4)).toBeUndefined();
  });
  it("is not fooled by a brace inside a string", () => {
    const src = ["function f() {", '  const s = "}";', "  return s;", "}"];
    expect(enclosingFunction("a.ts", src, 3)).toEqual({ name: "f", startLine: 1, endLine: 4 });
  });
});

describe("enclosingFunction (other)", () => {
  it("returns undefined for an unsupported extension", () => {
    expect(enclosingFunction("README.md", ["def x():", "  y()"], 2)).toBeUndefined();
  });
  it("reports which paths are supported", () => {
    expect(isSupportedSource("a.py")).toBe(true);
    expect(isSupportedSource("a.go")).toBe(true);
    expect(isSupportedSource("README.md")).toBe(false);
  });
});
