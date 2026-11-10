import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  GithubLinkedItem,
  GithubLinkRelation,
  GithubWorkItemKind,
} from "#/api/git-provider-items-service";
import { useGithubLinkedItems } from "#/hooks/query/use-github-work-items";
import { I18nKey } from "#/i18n/declaration";
import { GithubWorkItemState } from "./github-work-item-state";

const RELATION_LABEL: Record<GithubLinkRelation, I18nKey> = {
  closes: I18nKey.GITHUB$LINK_CLOSES,
  closed_by: I18nKey.GITHUB$LINK_CLOSED_BY,
  mentions: I18nKey.GITHUB$LINK_MENTIONS,
  mentioned_in: I18nKey.GITHUB$LINK_MENTIONED_IN,
};

interface GithubLinkedItemsProps {
  repository: string;
  number: number;
  body: string | null;
  /** Opens an item of this repository in the page (switching tab if needed). */
  onOpenItem: (kind: GithubWorkItemKind, number: number) => void;
}

/**
 * Issues and pull requests connected to the open one. Items of this
 * repository open in the page; items of other repositories open on GitHub.
 */
export function GithubLinkedItems({
  repository,
  number,
  body,
  onOpenItem,
}: GithubLinkedItemsProps) {
  const { t } = useTranslation("openhands");
  const { data: items, isLoading } = useGithubLinkedItems(
    repository,
    number,
    body ?? "",
  );

  // Linking is a convenience: a failure (rate limit, offline) just hides it.
  if (isLoading) {
    return (
      <p className="text-xs text-muted" data-testid="github-linked-loading">
        {t(I18nKey.HOME$LOADING)}
      </p>
    );
  }

  return (
    <section
      aria-labelledby="github-linked-heading"
      data-testid="github-linked-items"
      className="flex flex-col gap-2 rounded-lg border border-border p-4"
    >
      <h3
        id="github-linked-heading"
        className="text-sm font-semibold text-contrast"
      >
        {t(I18nKey.GITHUB$LINKED_ITEMS)}
      </h3>
      {items?.length ? (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <LinkedItemRow
              key={`${item.repository}#${item.number}`}
              item={item}
              sameRepository={
                item.repository.toLowerCase() === repository.toLowerCase()
              }
              onOpenItem={onOpenItem}
            />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">{t(I18nKey.GITHUB$LINKS_NONE)}</p>
      )}
    </section>
  );
}

interface LinkedItemRowProps {
  item: GithubLinkedItem;
  sameRepository: boolean;
  onOpenItem: GithubLinkedItemsProps["onOpenItem"];
}

function LinkedItemRow({
  item,
  sameRepository,
  onOpenItem,
}: LinkedItemRowProps) {
  const { t } = useTranslation("openhands");
  const label = (
    <>
      <GithubWorkItemState
        item={{
          kind: item.kind,
          state: item.state,
          merged: item.merged,
          draft: false,
        }}
        variant="icon"
        className="mt-0.5"
      />
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
        <span className="text-xs text-muted">
          {t(RELATION_LABEL[item.relation])}
        </span>
        <span className="text-sm text-contrast wrap-anywhere">
          {item.title}
        </span>
        <span className="text-xs text-muted tabular-nums">
          {sameRepository ? "" : `${item.repository}`}#{item.number}
        </span>
      </span>
    </>
  );

  return (
    <li>
      {sameRepository ? (
        <button
          type="button"
          data-testid={`github-linked-${item.kind}-${item.number}`}
          onClick={() => onOpenItem(item.kind, item.number)}
          className="flex w-full items-start gap-2 rounded-md px-1 py-1 text-left hover:bg-interactive-hover focus-visible:bg-interactive-hover focus-visible:outline-none"
        >
          {label}
        </button>
      ) : (
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          data-testid={`github-linked-${item.kind}-${item.number}`}
          className="flex items-start gap-2 rounded-md px-1 py-1 hover:bg-interactive-hover"
        >
          {label}
          <ExternalLink
            className="mt-0.5 size-3.5 shrink-0 text-muted"
            aria-hidden
          />
        </a>
      )}
    </li>
  );
}
