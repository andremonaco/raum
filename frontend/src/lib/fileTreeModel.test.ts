import { describe, expect, it } from "vitest";

import { sortDirEntries, type DirEntry } from "./fileTreeModel";

function entry(name: string, isDir = false): DirEntry {
  return { name, relPath: name, isDir };
}

describe("sortDirEntries", () => {
  it("sorts directories first, then files, both case-insensitively", () => {
    const sorted = sortDirEntries([
      entry("zebra.txt"),
      entry("src", true),
      entry("Apple.md"),
      entry("Crates", true),
      entry("beta.rs"),
    ]);
    expect(sorted.map((e) => e.name)).toEqual([
      "Crates",
      "src",
      "Apple.md",
      "beta.rs",
      "zebra.txt",
    ]);
  });

  it("orders numbered files naturally", () => {
    const sorted = sortDirEntries([entry("file10.txt"), entry("file2.txt"), entry("file1.txt")]);
    expect(sorted.map((e) => e.name)).toEqual(["file1.txt", "file2.txt", "file10.txt"]);
  });

  it("defensively drops .git even if the backend leaks it", () => {
    const sorted = sortDirEntries([entry(".git", true), entry("a.txt")]);
    expect(sorted.map((e) => e.name)).toEqual(["a.txt"]);
  });
});
