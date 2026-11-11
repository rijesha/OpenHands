import { describe, expect, it } from "vitest";
import {
  buildProjectProbeCommand,
  parseProjectProbe,
  shellQuote,
} from "#/utils/project-git-info";

describe("shellQuote", () => {
  it("keeps quotes, spaces and substitutions inert", () => {
    expect(shellQuote("/home/me/it's $(id)")).toBe(
      String.raw`'/home/me/it'\''s $(id)'`,
    );
  });
});

describe("buildProjectProbeCommand", () => {
  it("names every folder, quoted, in one command", () => {
    const command = buildProjectProbeCommand(["/a b", "/c'd"]);

    expect(command).toContain(String.raw`for d in '/a b' '/c'\''d'; do`);
  });
});

describe("parseProjectProbe", () => {
  it("tells git work trees from plain folders and reads their remote, branch and changes", () => {
    const result = parseProjectProbe(
      [
        "@@/code/widgets",
        "git",
        "git@github.com:acme/widgets.git",
        "main",
        "      3",
        "@@/code/notes",
        "local",
        "@@/code/scratch",
        "git",
        "",
        "HEAD",
        "0",
      ].join("\n"),
    );

    expect(result["/code/widgets"]).toMatchObject({
      isGit: true,
      repository: "acme/widgets",
      provider: "github",
      branch: "main",
      dirtyCount: 3,
    });
    expect(result["/code/notes"]).toMatchObject({
      isGit: false,
      repository: null,
    });
    // No remote and a detached HEAD are both just absent.
    expect(result["/code/scratch"]).toMatchObject({
      isGit: true,
      remoteUrl: null,
      repository: null,
      branch: null,
      dirtyCount: 0,
    });
  });
});
