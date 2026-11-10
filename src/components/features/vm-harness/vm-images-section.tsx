import { CornerDownRight } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import type { VmHarnessImage } from "#/api/vm-harness-service";
import {
  useDeleteVmImage,
  useLockVmImage,
  useStartVmLease,
  useUpdateVmImage,
} from "#/hooks/mutation/use-vm-harness-mutations";
import { I18nKey } from "#/i18n/declaration";
import {
  BASELINE_ORDER,
  formatBytes,
  groupImages,
  isBaselineImage,
  minutesLeft,
  orderImages,
  type BaselineRole,
  type ImageTreeRow,
} from "#/utils/vm-harness";
import { cn } from "#/utils/utils";
import { VmBaseChangeBar } from "./vm-base-change-bar";
import { VmActionError, VmButton, VmCard, vmInputClassName } from "./vm-ui";

/** A delete that is not confirmed within this time is dropped. */
const CONFIRM_WINDOW_MS = 6_000;

const ROLE_LABEL: Record<BaselineRole, I18nKey> = {
  windows: I18nKey.VM_HARNESS$ROLE_WINDOWS,
  "windows-workspace": I18nKey.VM_HARNESS$ROLE_WINDOWS_WORKSPACE,
  ubuntu: I18nKey.VM_HARNESS$ROLE_UBUNTU,
  "ubuntu-workspace": I18nKey.VM_HARNESS$ROLE_UBUNTU_WORKSPACE,
};

interface ImageRowProps {
  row: ImageTreeRow;
  /** When the image list was last read: how long an opened base has left is counted from it. */
  now: number;
  parent: VmHarnessImage | undefined;
  canStart: boolean;
  onChangeBase: (imageId: string) => void;
}

/** Bases are locked; snapshots can be edited and deleted freely. */
function VmImageRow({
  row,
  now,
  parent,
  canStart,
  onChangeBase,
}: ImageRowProps) {
  const { t } = useTranslation("openhands");
  const { image, depth } = row;
  const isBase = isBaselineImage(image);
  const open = isBase && !image.locked;
  const start = useStartVmLease();
  const lock = useLockVmImage();
  const update = useUpdateVmImage();
  const remove = useDeleteVmImage();
  const [editing, setEditing] = React.useState(false);
  const [label, setLabel] = React.useState(image.label ?? "");
  const [notes, setNotes] = React.useState(image.notes ?? "");
  const [armed, setArmed] = React.useState(false);

  React.useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(false), CONFIRM_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  let blocked: string | null = null;
  if (image.inUse) blocked = t(I18nKey.VM_HARNESS$BLOCKED_IN_USE);
  else if (image.children?.length) {
    blocked = t(I18nKey.VM_HARNESS$BLOCKED_CHILDREN, {
      ids: image.children.join(", "),
    });
  }

  const roleLabel = image.role
    ? t(ROLE_LABEL[image.role as BaselineRole] ?? ROLE_LABEL.windows)
    : t(I18nKey.VM_HARNESS$TYPE_BASE);
  let typeBadge: string;
  if (isBase) {
    typeBadge = open
      ? t(I18nKey.VM_HARNESS$BASE_OPEN, {
          role: roleLabel,
          minutes: minutesLeft(image.unlockedUntil ?? now, now),
        })
      : t(I18nKey.VM_HARNESS$BASE_LOCKED, { role: roleLabel });
  } else {
    typeBadge = t(
      image.baselineRoot
        ? I18nKey.VM_HARNESS$TYPE_SNAPSHOT
        : I18nKey.VM_HARNESS$TYPE_OTHER,
    );
  }

  return (
    <tr
      data-testid={`vm-image-${image.imageId}`}
      className="border-b border-border align-top last:border-0"
    >
      <td
        className="py-2 pr-2"
        style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}
      >
        <strong className="text-sm text-contrast wrap-anywhere">
          {depth ? (
            <CornerDownRight
              className="mr-1 inline size-3.5 text-muted"
              aria-hidden
            />
          ) : null}
          {image.label || image.imageId}
        </strong>
        <div className="text-xs text-muted wrap-anywhere">
          {image.label ? image.imageId : (image.description ?? image.os)}
        </div>
        {!isBase && parent ? (
          <div className="text-xs text-muted wrap-anywhere">
            {t(I18nKey.VM_HARNESS$SNAPSHOT_OF, {
              name: parent.label || parent.imageId,
            })}
          </div>
        ) : null}
        {image.notes ? (
          <div className="text-xs text-muted wrap-anywhere">
            {image.notes.slice(0, 200)}
          </div>
        ) : null}
        {editing ? (
          <form
            className="mt-2 flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              update.mutate(
                { imageId: image.imageId, label, notes },
                { onSuccess: () => setEditing(false) },
              );
            }}
          >
            <input
              type="text"
              maxLength={80}
              value={label}
              aria-label={t(I18nKey.VM_HARNESS$DISPLAY_NAME)}
              placeholder={t(I18nKey.VM_HARNESS$DISPLAY_NAME)}
              onChange={(event) => setLabel(event.target.value)}
              className={vmInputClassName}
            />
            <textarea
              rows={3}
              value={notes}
              aria-label={t(I18nKey.VM_HARNESS$NOTES)}
              placeholder={t(I18nKey.VM_HARNESS$NOTES)}
              onChange={(event) => setNotes(event.target.value)}
              className={cn(vmInputClassName, "h-auto py-1")}
            />
            <VmButton
              type="submit"
              className="self-start"
              disabled={update.isPending}
            >
              {t(I18nKey.BUTTON$SAVE)}
            </VmButton>
          </form>
        ) : null}
        <VmActionError
          error={start.error ?? lock.error ?? update.error ?? remove.error}
        />
      </td>
      <td className="py-2 pr-2">
        <span
          className={cn(
            "whitespace-nowrap rounded-full border px-2 text-xs",
            open ? "border-danger text-danger" : "border-border text-muted",
          )}
        >
          {typeBadge}
        </span>
      </td>
      <td className="whitespace-nowrap py-2 pr-2 text-xs text-muted">
        {formatBytes(image.sizeBytes)}
      </td>
      <td className="whitespace-nowrap py-2 pr-2 text-xs text-muted">
        {image.createdAt ? new Date(image.createdAt).toLocaleDateString() : "—"}
      </td>
      <td className="py-2">
        <div className="flex flex-wrap gap-1.5">
          <VmButton
            data-testid={`vm-start-${image.imageId}`}
            disabled={!canStart || start.isPending}
            onClick={() => start.mutate(image.imageId)}
          >
            {t(
              image.kind === "golden"
                ? I18nKey.VM_HARNESS$START_CLEAN
                : I18nKey.VM_HARNESS$START,
            )}
          </VmButton>
          {isBase && !open ? (
            <VmButton onClick={() => onChangeBase(image.imageId)}>
              {t(I18nKey.VM_HARNESS$CHANGE_BASE)}
            </VmButton>
          ) : null}
          {open ? (
            <VmButton
              disabled={lock.isPending}
              onClick={() => lock.mutate(image.imageId)}
            >
              {t(I18nKey.VM_HARNESS$LOCK_NOW)}
            </VmButton>
          ) : null}
          {/* Edit and Delete exist for snapshots, and for a base only while it is open. */}
          {!isBase || open ? (
            <>
              <VmButton onClick={() => setEditing((value) => !value)}>
                {t(I18nKey.BUTTON$EDIT)}
              </VmButton>
              <VmButton
                tone="danger"
                data-testid={`vm-delete-${image.imageId}`}
                disabled={Boolean(blocked) || remove.isPending}
                title={blocked ?? undefined}
                onClick={() => {
                  if (armed) remove.mutate(image.imageId);
                  else setArmed(true);
                }}
              >
                {armed
                  ? t(I18nKey.VM_HARNESS$DELETE_CONFIRM, {
                      size: formatBytes(image.sizeBytes),
                    })
                  : t(I18nKey.BUTTON$DELETE)}
              </VmButton>
            </>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

interface ImagesTableProps {
  rows: ImageTreeRow[];
  now: number;
  byId: Map<string, VmHarnessImage>;
  canStart: boolean;
  onChangeBase: (imageId: string) => void;
}

function VmImagesTable({
  rows,
  now,
  byId,
  canStart,
  onChangeBase,
}: ImagesTableProps) {
  const { t } = useTranslation("openhands");
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-border text-xs text-muted">
            <th className="py-1 pr-2 font-medium">
              {t(I18nKey.SETTINGS$NAME)}
            </th>
            <th className="py-1 pr-2 font-medium">
              {t(I18nKey.BACKEND$KIND_LABEL)}
            </th>
            <th className="py-1 pr-2 font-medium">
              {t(I18nKey.VM_HARNESS$COLUMN_SIZE)}
            </th>
            <th className="py-1 pr-2 font-medium">
              {t(I18nKey.CONVERSATION$CREATED)}
            </th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <VmImageRow
              key={row.image.imageId}
              row={row}
              now={now}
              parent={
                row.image.parentImageId
                  ? byId.get(row.image.parentImageId)
                  : undefined
              }
              canStart={canStart}
              onChangeBase={onChangeBase}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface VmImagesSectionProps {
  images: VmHarnessImage[];
  /** When `images` was last read (epoch ms). */
  readAt: number;
  imagesDir?: string;
  /** Whether another VM may be started now. */
  canStart: boolean;
}

/** Base images (locked, changed only through an agent), snapshots made from them, and strays. */
export function VmImagesSection({
  images,
  readAt,
  imagesDir,
  canStart,
}: VmImagesSectionProps) {
  const { t } = useTranslation("openhands");
  const { bases, snaps, other } = groupImages(images);
  const byId = new Map(images.map((image) => [image.imageId, image]));
  const total = images.reduce((sum, image) => sum + (image.sizeBytes ?? 0), 0);
  const [baseId, setBaseId] = React.useState("");
  const changeInput = React.useRef<HTMLInputElement>(null);
  const selectedBase = bases.some((base) => base.imageId === baseId)
    ? baseId
    : (bases[0]?.imageId ?? "");

  const changeBase = (imageId: string) => {
    setBaseId(imageId);
    changeInput.current?.focus();
  };

  const have = new Set(bases.map((base) => base.role).filter(Boolean));
  const missing = BASELINE_ORDER.filter((role) => !have.has(role));

  return (
    <>
      <VmCard
        testId="vm-bases"
        title={t(I18nKey.VM_HARNESS$BASES_TITLE, { count: bases.length })}
        description={t(I18nKey.VM_HARNESS$BASES_HELP)}
      >
        {bases.length > 0 ? (
          <VmImagesTable
            rows={orderImages(bases)}
            byId={byId}
            now={readAt}
            canStart={canStart}
            onChangeBase={changeBase}
          />
        ) : (
          <p className="text-xs text-muted wrap-anywhere">
            {t(I18nKey.VM_HARNESS$BASES_NONE, {
              dir: imagesDir ?? t(I18nKey.VM_HARNESS$IMAGES_FOLDER),
            })}
          </p>
        )}
        {missing.length > 0 ? (
          <p data-testid="vm-missing-baselines" className="text-xs text-muted">
            {t(I18nKey.VM_HARNESS$BASES_MISSING, {
              roles: missing.map((role) => t(ROLE_LABEL[role])).join(", "),
            })}
          </p>
        ) : null}
        {bases.length > 0 ? (
          <VmBaseChangeBar
            bases={bases}
            baseId={selectedBase}
            onBaseChange={setBaseId}
            inputRef={changeInput}
          />
        ) : null}
      </VmCard>

      <VmCard
        testId="vm-snapshots"
        title={t(I18nKey.VM_HARNESS$SNAPSHOTS_TITLE, { count: snaps.length })}
        description={t(I18nKey.VM_HARNESS$SNAPSHOTS_HELP)}
      >
        {snaps.length > 0 ? (
          <VmImagesTable
            rows={orderImages(snaps)}
            byId={byId}
            now={readAt}
            canStart={canStart}
            onChangeBase={changeBase}
          />
        ) : (
          <p className="text-xs text-muted">
            {t(I18nKey.VM_HARNESS$SNAPSHOTS_NONE)}
          </p>
        )}
        {images.length > 0 ? (
          <p className="text-xs text-muted">
            {t(I18nKey.VM_HARNESS$DISK_TOTAL, { size: formatBytes(total) })}
          </p>
        ) : null}
      </VmCard>

      {other.length > 0 ? (
        <VmCard
          testId="vm-other-images"
          title={t(I18nKey.VM_HARNESS$OTHER_TITLE, { count: other.length })}
          description={t(I18nKey.VM_HARNESS$OTHER_HELP)}
        >
          <VmImagesTable
            rows={orderImages(other)}
            byId={byId}
            now={readAt}
            canStart={canStart}
            onChangeBase={changeBase}
          />
        </VmCard>
      ) : null}
    </>
  );
}
