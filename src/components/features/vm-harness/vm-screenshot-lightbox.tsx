import React from "react";
import { useTranslation } from "react-i18next";
import type { VmHarnessStep } from "#/api/vm-harness-service";
import { ModalBackdrop } from "#/components/shared/modals/modal-backdrop";
import { ModalCloseButton } from "#/components/shared/modals/modal-close-button";
import { useVmHarnessScreenshot } from "#/hooks/query/use-vm-harness";
import { I18nKey } from "#/i18n/declaration";
import { cn } from "#/utils/utils";
import { VmStep } from "./vm-run-report";

interface VmScreenshotLightboxProps {
  runId: string;
  /** Screenshot file names in the order they are stepped through. */
  names: string[];
  startIndex: number;
  stepsByName: Map<string, VmHarnessStep[]>;
  onClose: () => void;
}

/** Full-size view of a run's screenshots with the steps each one is evidence for. */
export function VmScreenshotLightbox({
  runId,
  names,
  startIndex,
  stepsByName,
  onClose,
}: VmScreenshotLightboxProps) {
  const { t } = useTranslation("openhands");
  const [index, setIndex] = React.useState(
    Math.min(Math.max(startIndex, 0), names.length - 1),
  );
  const [actualSize, setActualSize] = React.useState(false);
  const name = names[index];
  const steps = stepsByName.get(name) ?? [];
  const shot = useVmHarnessScreenshot(runId, name);
  // Neighbours load ahead so the arrow keys feel instant.
  useVmHarnessScreenshot(runId, names[index + 1] ?? name, {
    enabled: index + 1 < names.length,
  });
  useVmHarnessScreenshot(runId, names[index - 1] ?? name, {
    enabled: index > 0,
  });

  const go = React.useCallback(
    (next: number) => setIndex(Math.min(Math.max(next, 0), names.length - 1)),
    [names.length],
  );

  // HeroUI consumes Escape on a document capture listener, so the backdrop's own
  // listener never sees it: take the keys here, like the single-image lightbox.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowRight") go(index + 1);
      else if (event.key === "ArrowLeft") go(index - 1);
      else if (event.key === "Home") go(0);
      else if (event.key === "End") go(names.length - 1);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [go, index, names.length, onClose]);

  const navButton =
    "rounded-md border border-border bg-base-secondary px-3 py-1.5 text-sm text-contrast hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <ModalBackdrop
      onClose={onClose}
      closeOnEscape={false}
      aria-label={t(I18nKey.VM_HARNESS$GALLERY)}
    >
      <div
        data-testid="vm-lightbox"
        className="relative flex max-h-[92vh] w-[92vw] max-w-5xl flex-col gap-3 rounded-xl border border-border bg-base-secondary p-4"
      >
        <ModalCloseButton onClose={onClose} testId="vm-lightbox-close" />
        <div className="flex flex-wrap items-center gap-3 pr-8 text-sm">
          <strong className="text-contrast wrap-anywhere">{name}</strong>
          <span className="text-muted" data-testid="vm-lightbox-counter">
            {index + 1} / {names.length}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            data-testid="vm-lightbox-prev"
            className={navButton}
            disabled={index === 0}
            onClick={() => go(index - 1)}
          >
            {t(I18nKey.VM_HARNESS$PREVIOUS)}
          </button>
          <button
            type="button"
            data-testid="vm-lightbox-next"
            className={navButton}
            disabled={index === names.length - 1}
            onClick={() => go(index + 1)}
          >
            {t(I18nKey.VM_HARNESS$NEXT)}
          </button>
          <button
            type="button"
            className={navButton}
            onClick={() => setActualSize((value) => !value)}
          >
            {t(
              actualSize
                ? I18nKey.VM_HARNESS$FIT_TO_SCREEN
                : I18nKey.VM_HARNESS$ACTUAL_SIZE,
            )}
          </button>
        </div>
        <div className="flex min-h-40 flex-1 items-center justify-center overflow-auto rounded-md bg-black">
          {shot.data ? (
            <img
              src={shot.data}
              alt={name}
              data-testid="vm-lightbox-image"
              className={cn(
                actualSize
                  ? "max-h-none max-w-none"
                  : "max-h-[60vh] max-w-full object-contain",
              )}
            />
          ) : (
            <span className={shot.isError ? "text-danger" : "text-muted"}>
              {t(
                shot.isError
                  ? I18nKey.VM_HARNESS$SCREENSHOT_FAILED
                  : I18nKey.HOME$LOADING,
              )}
            </span>
          )}
        </div>
        <div className="flex max-h-40 flex-col gap-2 overflow-auto text-sm">
          {steps.length > 0 ? (
            steps.map((step) => <VmStep key={step.id} step={step} />)
          ) : (
            <span className="text-muted">
              {t(I18nKey.VM_HARNESS$NOT_CITED)}
            </span>
          )}
        </div>
      </div>
    </ModalBackdrop>
  );
}
