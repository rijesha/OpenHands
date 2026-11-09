import { describe, expect, it } from "vitest";
import { parseGithubRepository } from "#/utils/parse-github-repository";

describe("parseGithubRepository", () => {
  it.each([
    ["acme/widgets", "acme/widgets"],
    ["  acme/widgets.js  ", "acme/widgets.js"],
    ["https://github.com/acme/widgets", "acme/widgets"],
    ["https://github.com/acme/widgets/issues/5", "acme/widgets"],
    ["https://github.com/acme/widgets.git", "acme/widgets"],
    ["github.com/acme/widgets/pull/7", "acme/widgets"],
    ["git@github.com:acme/widgets.git", "acme/widgets"],
  ])("reads %j as %j", (input, expected) => {
    expect(parseGithubRepository(input)).toBe(expected);
  });

  it.each([
    "",
    "acme",
    "acme/widgets/extra",
    "https://gitlab.com/acme/widgets",
    "https://github.com/acme",
    "acme/wid gets",
  ])("rejects %j", (input) => {
    expect(parseGithubRepository(input)).toBeNull();
  });
});
