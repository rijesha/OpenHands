import React from "react";
import { useTranslation } from "react-i18next";
import type { VmHarnessLease } from "#/api/vm-harness-service";
import { useNavigation } from "#/context/navigation-context";
import {
  useExtendVmLease,
  useSendVmInput,
  useSnapshotVmLease,
  useStopVmLease,
} from "#/hooks/mutation/use-vm-harness-mutations";
import { useVmHarnessLeaseScreenshot } from "#/hooks/query/use-vm-harness";
import { I18nKey } from "#/i18n/declaration";
import {
  githubItemPath,
  minutesUntil,
  toScreenPoint,
} from "#/utils/vm-harness";
import { VmLeaseStatusLabel } from "./vm-lease-status";
import {
  VmActionError,
  VmButton,
  vmCardClassName,
  vmInputClassName,
} from "./vm-ui";

const SCREEN_REFRESH_MS = 5_000;
/** How long the VM gets to react before its screen is read again. */
const SCREEN_SETTLE_MS = 600;

/** Click the screen, type text or press a key in a ready VM, as an agent would. */
function VmManualControls({
  lease,
  screen,
  onSent,
}: {
  lease: VmHarnessLease;
  screen: string | null | undefined;
  onSent: () => void;
}) {
  const { t } = useTranslation("openhands");
  const send = useSendVmInput();
  const [text, setText] = React.useState("");
  const [combo, setCombo] = React.useState("");

  const sendAction = (
    action: Parameters<typeof send.mutate>[0]["action"],
    done?: () => void,
  ) =>
    send.mutate(
      { leaseId: lease.id, action },
      {
        onSuccess: () => {
          done?.();
          setTimeout(onSent, SCREEN_SETTLE_MS);
        },
      },
    );

  return (
    <div data-testid="vm-manual-controls" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (text) sendAction({ type: "type", text }, () => setText(""));
          }}
        >
          <input
            type="text"
            maxLength={200}
            value={text}
            data-testid="vm-type-input"
            aria-label={t(I18nKey.VM_HARNESS$TYPE_LABEL)}
            placeholder={t(I18nKey.VM_HARNESS$TYPE_LABEL)}
            onChange={(event) => setText(event.target.value)}
            className={`${vmInputClassName} min-w-32 flex-1`}
          />
          <VmButton type="submit" disabled={!text || send.isPending}>
            {t(I18nKey.VM_HARNESS$TYPE_BUTTON)}
          </VmButton>
        </form>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (combo.trim()) {
              sendAction({ type: "key", combo: combo.trim() }, () =>
                setCombo(""),
              );
            }
          }}
        >
          <input
            type="text"
            maxLength={40}
            value={combo}
            data-testid="vm-key-input"
            aria-label={t(I18nKey.VM_HARNESS$KEY_LABEL)}
            placeholder={t(I18nKey.VM_HARNESS$KEY_LABEL)}
            onChange={(event) => setCombo(event.target.value)}
            className={`${vmInputClassName} w-40`}
          />
          <VmButton type="submit" disabled={!combo.trim() || send.isPending}>
            {t(I18nKey.VM_HARNESS$KEY_BUTTON)}
          </VmButton>
        </form>
      </div>
      <VmActionError error={send.error} />
      <ClickSurface lease={lease} src={screen} onClick={sendAction} />
    </div>
  );
}

/** The VM's screen: a click on it is a click in the VM. */
function ClickSurface({
  lease,
  src,
  onClick,
}: {
  lease: VmHarnessLease;
  src: string | null | undefined;
  onClick: (action: { type: "click"; x: number; y: number }) => void;
}) {
  const { t } = useTranslation("openhands");
  if (!src) return null;
  return (
    // A button, so the screen is a named control; only a pointer click carries a position.
    <button
      type="button"
      title={t(I18nKey.VM_HARNESS$CLICK_HINT)}
      className="block w-full cursor-pointer rounded-md"
      onClick={(event) => {
        const screen = event.currentTarget.querySelector("img");
        const box = screen?.getBoundingClientRect();
        if (!box?.width || !box.height || event.detail === 0) return;
        // The screenshot is the guest's screen at 1:1, so its pixel size is the coordinate space.
        const natural =
          screen?.naturalWidth && screen.naturalHeight
            ? { width: screen.naturalWidth, height: screen.naturalHeight }
            : undefined;
        onClick({
          type: "click",
          ...toScreenPoint(
            event.clientX - box.left,
            event.clientY - box.top,
            box.width,
            box.height,
            natural,
          ),
        });
      }}
    >
      <img
        src={src}
        alt={t(I18nKey.VM_HARNESS$SCREEN_ALT, { id: lease.id })}
        data-testid="vm-screen"
        className="w-full rounded-md border border-border bg-black"
      />
    </button>
  );
}

/** One VM that is booting or ready: its screen, how long it will live, and what can be done with it. */
export function VmLeaseCard({ lease }: { lease: VmHarnessLease }) {
  const { t } = useTranslation("openhands");
  const { navigate } = useNavigation();
  const stop = useStopVmLease();
  const extend = useExtendVmLease();
  const snapshot = useSnapshotVmLease();
  const [naming, setNaming] = React.useState(false);
  const [name, setName] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const ready = lease.status === "ready";
  const screen = useVmHarnessLeaseScreenshot(lease.id, {
    enabled: ready,
    refetchMs: SCREEN_REFRESH_MS,
  });
  const minutes = minutesUntil(lease.ttlSecondsLeft);
  const { repository, item, kind } = lease.context ?? {};

  return (
    <article data-testid={`vm-lease-${lease.id}`} className={vmCardClassName}>
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm text-contrast">{lease.id}</strong>
        <span className="rounded-full border border-border px-2 text-xs text-muted">
          <VmLeaseStatusLabel lease={lease} />
        </span>
        <VmButton
          data-testid={`vm-stop-${lease.id}`}
          disabled={stop.isPending}
          onClick={() => stop.mutate(lease.id)}
        >
          {t(I18nKey.BUTTON$STOP)}
        </VmButton>
        <VmButton
          disabled={extend.isPending}
          onClick={() => extend.mutate(lease.id)}
        >
          {t(I18nKey.VM_HARNESS$EXTEND)}
        </VmButton>
        {ready ? (
          <VmButton onClick={() => setNaming((open) => !open)}>
            {t(I18nKey.VM_HARNESS$SAVE_SNAPSHOT)}
          </VmButton>
        ) : null}
      </div>
      {minutes !== null ? (
        <p className="text-xs text-muted" data-testid="vm-lease-ttl">
          {t(I18nKey.VM_HARNESS$TTL, { minutes })}
          {lease.memoryMB
            ? ` ${t(I18nKey.VM_HARNESS$LEASE_MEMORY, { mb: lease.memoryMB })}`
            : ""}
        </p>
      ) : null}
      {repository ? (
        <button
          type="button"
          data-testid={`vm-lease-item-${lease.id}`}
          onClick={() => navigate(githubItemPath(repository, item ?? "", kind))}
          className="self-start text-xs text-primary underline hover:no-underline"
        >
          {t(I18nKey.VM_HARNESS$FOR_ITEM, {
            item: `${repository}${item ? `#${item}` : ""}`,
          })}
        </button>
      ) : null}
      <p className="text-xs text-muted">
        {lease.imageId} · {lease.os}
        {lease.ip ? ` · ${lease.ip}` : ""}
      </p>
      {lease.error ? (
        <p className="text-xs text-danger wrap-anywhere">{lease.error}</p>
      ) : null}
      {naming ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            snapshot.mutate({
              leaseId: lease.id,
              name: name.trim(),
              notes: notes.trim(),
            });
          }}
        >
          <input
            type="text"
            maxLength={60}
            value={name}
            data-testid="vm-snapshot-name"
            aria-label={t(I18nKey.VM_HARNESS$SNAPSHOT_NAME)}
            placeholder={t(I18nKey.VM_HARNESS$SNAPSHOT_NAME)}
            onChange={(event) => setName(event.target.value)}
            className={`${vmInputClassName} min-w-40 flex-1`}
          />
          <input
            type="text"
            value={notes}
            aria-label={t(I18nKey.VM_HARNESS$SNAPSHOT_NOTES)}
            placeholder={t(I18nKey.VM_HARNESS$SNAPSHOT_NOTES)}
            onChange={(event) => setNotes(event.target.value)}
            className={`${vmInputClassName} min-w-40 flex-1`}
          />
          <VmButton
            type="submit"
            data-testid="vm-snapshot-save"
            disabled={snapshot.isPending || !name.trim()}
          >
            {t(I18nKey.VM_HARNESS$SNAPSHOT_SAVE)}
          </VmButton>
        </form>
      ) : null}
      {snapshot.isPending ? (
        <p className="text-xs text-muted">
          {t(I18nKey.VM_HARNESS$SNAPSHOT_SAVING)}
        </p>
      ) : null}
      <VmActionError error={stop.error ?? extend.error ?? snapshot.error} />
      {ready ? (
        <VmManualControls
          lease={lease}
          screen={screen.data}
          onSent={() => screen.refetch()}
        />
      ) : null}
    </article>
  );
}
