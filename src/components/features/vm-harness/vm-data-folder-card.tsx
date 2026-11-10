import React from "react";
import { useTranslation } from "react-i18next";
import type { VmHarnessSettings } from "#/api/vm-harness-service";
import { useSaveVmHarnessRoot } from "#/hooks/mutation/use-vm-harness-mutations";
import {
  useVmHarnessBrowse,
  useVmHarnessSettings,
} from "#/hooks/query/use-vm-harness";
import { I18nKey } from "#/i18n/declaration";
import { VmActionError, VmButton, VmCard, vmInputClassName } from "./vm-ui";

/** An example of a data folder, not copy: it is a path on the host, so it follows the host's path style. */
export function folderPlaceholder(currentRoot: string | undefined): string {
  return currentRoot?.includes("\\") || /^[A-Za-z]:/.test(currentRoot ?? "")
    ? String.raw`D:\zide-ai-qa`
    : "/Users/you/vm-harness";
}

const SOURCE_NOTE: Record<string, I18nKey> = {
  settings: I18nKey.VM_HARNESS$FOLDER_SOURCE_SETTINGS,
  env: I18nKey.VM_HARNESS$FOLDER_SOURCE_ENV,
};

/** `listing.path` plus one folder name, with the separator the host uses. */
function joinPath(base: string, name: string): string {
  if (!base) return name;
  const separator = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]$/, "")}${separator}${name}`;
}

interface FolderPickerProps {
  start: string;
  onChoose: (path: string) => void;
}

/**
 * Browses the host's folders (the browser cannot see the host's disk itself)
 * to choose where the harness keeps images, secrets and run data.
 */
function VmFolderPicker({ start, onChoose }: FolderPickerProps) {
  const { t } = useTranslation("openhands");
  const [path, setPath] = React.useState(start);
  const listing = useVmHarnessBrowse(path);

  if (listing.isError) {
    return (
      <div className="rounded-md border border-border p-2">
        <VmActionError error={listing.error} />
      </div>
    );
  }
  const data = listing.data;
  if (!data) {
    return <p className="text-xs text-muted">{t(I18nKey.HOME$LOADING)}</p>;
  }

  return (
    <div
      data-testid="vm-folder-picker"
      className="flex flex-col gap-2 rounded-md border border-border p-2"
    >
      <strong className="text-xs text-contrast wrap-anywhere">
        {data.path || t(I18nKey.VM_HARNESS$FOLDER_DRIVES)}
      </strong>
      <div className="flex max-h-56 flex-col overflow-auto rounded-md border border-border p-1 custom-scrollbar">
        {data.parent !== null && data.path ? (
          <button
            type="button"
            onClick={() => setPath(data.parent ?? "")}
            className="rounded px-2 py-1 text-left text-xs text-primary hover:bg-interactive-hover"
          >
            {t(I18nKey.VM_HARNESS$FOLDER_UP)}
          </button>
        ) : null}
        {data.dirs.map((dir) => (
          <button
            key={dir}
            type="button"
            onClick={() => setPath(joinPath(data.path, dir))}
            className="rounded px-2 py-1 text-left text-xs text-primary hover:bg-interactive-hover"
          >
            {dir}
          </button>
        ))}
        {data.dirs.length === 0 ? (
          <span className="px-2 py-1 text-xs text-muted">
            {t(I18nKey.VM_HARNESS$FOLDER_EMPTY)}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {data.path ? (
          <VmButton onClick={() => onChoose(data.path)}>
            {t(I18nKey.VM_HARNESS$FOLDER_USE)}
          </VmButton>
        ) : null}
        {data.path ? (
          <span
            className={
              data.hasImages ? "text-xs text-success" : "text-xs text-muted"
            }
          >
            {t(
              data.hasImages
                ? I18nKey.VM_HARNESS$FOLDER_HAS_IMAGES
                : I18nKey.VM_HARNESS$FOLDER_NO_IMAGES,
            )}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function sourceNote(settings: VmHarnessSettings | undefined): I18nKey {
  return (
    SOURCE_NOTE[settings?.rootSource ?? ""] ??
    I18nKey.VM_HARNESS$FOLDER_SOURCE_DEFAULT
  );
}

/** The folder that holds the harness's images, secrets and run data. */
export function VmDataFolderCard() {
  const { t } = useTranslation("openhands");
  const { data: settings } = useVmHarnessSettings();
  const save = useSaveVmHarnessRoot();
  const [draft, setDraft] = React.useState<string | null>(null);
  const [browsing, setBrowsing] = React.useState(false);

  const value = draft ?? settings?.root ?? "";
  // The harness refuses a folder change while VMs run from the current one.
  const locked = (settings?.runningVms ?? 0) > 0;

  const apply = (root: string) =>
    save.mutate(root, {
      onSuccess: () => {
        setDraft(null);
        setBrowsing(false);
      },
    });

  // An empty field that fills in a moment later invites typing over it.
  if (!settings) {
    return (
      <VmCard
        testId="vm-data-folder"
        title={t(I18nKey.VM_HARNESS$FOLDER_TITLE)}
      >
        <p className="text-xs text-muted">{t(I18nKey.HOME$LOADING)}</p>
      </VmCard>
    );
  }

  return (
    <VmCard
      testId="vm-data-folder"
      title={t(I18nKey.VM_HARNESS$FOLDER_TITLE)}
      description={
        <>
          {t(I18nKey.VM_HARNESS$FOLDER_HELP)} {t(sourceNote(settings))}
        </>
      }
    >
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          apply(value.trim());
        }}
      >
        <input
          type="text"
          data-testid="vm-folder-input"
          aria-label={t(I18nKey.VM_HARNESS$FOLDER_LABEL)}
          placeholder={folderPlaceholder(settings.root)}
          value={value}
          disabled={locked}
          onChange={(event) => setDraft(event.target.value)}
          className={`${vmInputClassName} min-w-48 flex-1`}
        />
        <VmButton
          disabled={locked}
          data-testid="vm-folder-browse"
          onClick={() => setBrowsing((open) => !open)}
        >
          {t(I18nKey.VM_HARNESS$FOLDER_BROWSE)}
        </VmButton>
        <VmButton
          type="submit"
          data-testid="vm-folder-save"
          disabled={locked || save.isPending || !value.trim()}
        >
          {t(I18nKey.BUTTON$SAVE)}
        </VmButton>
      </form>
      {browsing ? (
        <VmFolderPicker
          start={value.trim()}
          onChoose={(path) => {
            setDraft(path);
            setBrowsing(false);
          }}
        />
      ) : null}
      {save.isSuccess ? (
        <p data-testid="vm-folder-saved" className="text-xs text-success">
          {t(I18nKey.VM_HARNESS$FOLDER_SAVED, {
            root: save.data.root,
            count: save.data.imageCount ?? 0,
          })}
        </p>
      ) : null}
      <VmActionError error={save.error} />
      {locked ? (
        <p className="text-xs text-muted">
          {t(I18nKey.VM_HARNESS$FOLDER_LOCKED)}
        </p>
      ) : null}
      {settings?.hasGuestKey === false ? (
        <p className="text-xs text-danger wrap-anywhere">
          {t(I18nKey.VM_HARNESS$FOLDER_NO_KEY, { root: settings.root })}
        </p>
      ) : null}
    </VmCard>
  );
}
