import React from "react";
import { useSearchParams } from "react-router";
import type {
  GithubWorkItemKind,
  GithubWorkItemStateFilter,
} from "#/api/git-provider-items-service";
import { GithubPage } from "#/components/features/github/github-page";
import { parseGithubRepository } from "#/utils/parse-github-repository";

// The URL is the only owner of the page's selection, so a link (or Back)
// reopens the same repository, tab, filter and item.
const REPOSITORY_PARAM = "repo";
const TAB_PARAM = "tab";
const STATE_PARAM = "state";
const ITEM_PARAM = "item";

const PULL_REQUESTS_TAB = "pulls";
const DEFAULT_STATE: GithubWorkItemStateFilter = "open";
const STATE_VALUES: readonly GithubWorkItemStateFilter[] = [
  "open",
  "closed",
  "all",
];

function parseState(value: string | null): GithubWorkItemStateFilter {
  return STATE_VALUES.find((state) => state === value) ?? DEFAULT_STATE;
}

function parseItemNumber(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return number > 0 ? number : null;
}

type ParamPatch = Record<string, string | null>;

export default function GithubRoute() {
  const [searchParams, setSearchParams] = useSearchParams();

  const repository = parseGithubRepository(searchParams.get(REPOSITORY_PARAM));
  const kind: GithubWorkItemKind =
    searchParams.get(TAB_PARAM) === PULL_REQUESTS_TAB
      ? "pull_request"
      : "issue";
  const state = parseState(searchParams.get(STATE_PARAM));
  const selectedNumber = parseItemNumber(searchParams.get(ITEM_PARAM));

  const update = React.useCallback(
    (patch: ParamPatch, { replace }: { replace: boolean }) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace },
      );
    },
    [setSearchParams],
  );

  return (
    <GithubPage
      repository={repository}
      kind={kind}
      state={state}
      selectedNumber={selectedNumber}
      onRepositoryChange={(next) =>
        update(
          { [REPOSITORY_PARAM]: next, [ITEM_PARAM]: null },
          { replace: false },
        )
      }
      onKindChange={(next) =>
        update(
          {
            [TAB_PARAM]: next === "pull_request" ? PULL_REQUESTS_TAB : null,
            [ITEM_PARAM]: null,
          },
          { replace: true },
        )
      }
      onStateChange={(next) =>
        update(
          { [STATE_PARAM]: next === DEFAULT_STATE ? null : next },
          { replace: true },
        )
      }
      onSelectItem={(number) =>
        update(
          { [ITEM_PARAM]: number === null ? null : String(number) },
          { replace: false },
        )
      }
    />
  );
}
