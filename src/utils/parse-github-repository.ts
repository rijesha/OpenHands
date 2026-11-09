import { parseGitRemoteUrl } from "#/utils/parse-git-remote-url";

const OWNER_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Normalize user input naming a GitHub repository to `owner/repo`. Accepts
 * `owner/repo`, and github.com URLs including deep links such as
 * `https://github.com/owner/repo/issues/5` or clone URLs. Returns null for
 * anything else, including other providers' URLs.
 */
export function parseGithubRepository(
  input: string | null | undefined,
): string | null {
  const value = input?.trim().replace(/\.git$/, "") ?? "";
  if (!value) return null;
  if (OWNER_REPO_PATTERN.test(value)) return value;

  const parsed = parseGitRemoteUrl(
    /^github\.com\//i.test(value) ? `https://${value}` : value,
  );
  if (parsed?.provider !== "github" || !parsed.repository) return null;

  const [owner, repo] = parsed.repository.split("/");
  const repository = owner && repo ? `${owner}/${repo}` : null;
  return repository && OWNER_REPO_PATTERN.test(repository) ? repository : null;
}
