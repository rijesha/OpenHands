import React from "react";
import { useTranslation } from "react-i18next";
import type { VmHarnessStep } from "#/api/vm-harness-service";
import { useVmHarnessScreenshot } from "#/hooks/query/use-vm-harness";
import { useInView } from "#/hooks/use-in-view";
import { I18nKey } from "#/i18n/declaration";
import { stepsByScreenshot } from "#/utils/vm-harness";
import { cn } from "#/utils/utils";
import { VmScreenshotLightbox } from "./vm-screenshot-lightbox";

type GalleryFilter = "all" | "evidence" | "failed";

const FILTERS: ReadonlyArray<{ filter: GalleryFilter; label: I18nKey }> = [
  { filter: "all", label: I18nKey.VM_HARNESS$FILTER_ALL },
  { filter: "evidence", label: I18nKey.VM_HARNESS$FILTER_CITED },
  { filter: "failed", label: I18nKey.VM_HARNESS$FILTER_FAILED },
];

interface ThumbProps {
  runId: string;
  name: string;
  steps: VmHarnessStep[];
  onOpen: () => void;
}

/** A thumbnail that fetches its image once it nears the viewport. */
function VmScreenshotThumb({ runId, name, steps, onOpen }: ThumbProps) {
  const { t } = useTranslation("openhands");
  const { ref, inView } = useInView<HTMLButtonElement>();
  const shot = useVmHarnessScreenshot(runId, name, { enabled: inView });
  const failing = steps.some((step) => step.status !== "pass");

  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1">
      <button
        ref={ref}
        type="button"
        data-testid={`vm-screenshot-${name}`}
        aria-label={t(I18nKey.VM_HARNESS$OPEN_SCREENSHOT, { name })}
        onClick={onOpen}
        className="relative aspect-[16/10] w-full overflow-hidden rounded-md border border-border bg-black"
      >
        {shot.data ? (
          <img
            src={shot.data}
            alt={name}
            className="size-full object-contain"
          />
        ) : null}
        {steps.length > 0 ? (
          <span
            className={cn(
              "absolute left-1 top-1 rounded-full bg-black/70 px-1.5 text-[11px]",
              failing ? "text-danger" : "text-success",
            )}
          >
            {steps.map((step) => step.id).join(", ")}
          </span>
        ) : null}
      </button>
      <figcaption className="truncate text-xs text-muted">{name}</figcaption>
    </figure>
  );
}

interface VmScreenshotGalleryProps {
  runId: string;
  /** Screenshot file names of the run. */
  screenshots: string[];
  steps: VmHarnessStep[];
}

/**
 * Every screenshot of a run, filterable to the ones steps cite as evidence
 * (or the ones behind a failed step), opening a lightbox to step through them.
 */
export function VmScreenshotGallery({
  runId,
  screenshots,
  steps,
}: VmScreenshotGalleryProps) {
  const { t } = useTranslation("openhands");
  const [filter, setFilter] = React.useState<GalleryFilter>("all");
  const [openIndex, setOpenIndex] = React.useState<number | null>(null);

  const names = React.useMemo(() => [...screenshots].sort(), [screenshots]);
  const stepsByName = React.useMemo(() => stepsByScreenshot(steps), [steps]);

  const shown = names.filter((name) => {
    const cited = stepsByName.get(name) ?? [];
    if (filter === "evidence") return cited.length > 0;
    if (filter === "failed") return cited.some((s) => s.status !== "pass");
    return true;
  });

  if (names.length === 0) {
    return (
      <p className="text-sm text-muted">
        {t(I18nKey.VM_HARNESS$NO_SCREENSHOTS)}
      </p>
    );
  }

  return (
    <section
      data-testid="vm-screenshot-gallery"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h4 className="text-xs font-semibold text-contrast">
          {t(I18nKey.VM_HARNESS$SCREENSHOTS, {
            shown: shown.length,
            total: names.length,
          })}
        </h4>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((option) => (
            <button
              key={option.filter}
              type="button"
              data-testid={`vm-filter-${option.filter}`}
              aria-pressed={filter === option.filter}
              onClick={() => setFilter(option.filter)}
              className={cn(
                "rounded-md border border-border px-2 py-1 text-xs",
                filter === option.filter
                  ? "bg-interactive-selected text-contrast"
                  : "text-muted hover:text-contrast",
              )}
            >
              {t(option.label)}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3">
        {shown.map((name, index) => (
          <VmScreenshotThumb
            key={name}
            runId={runId}
            name={name}
            steps={stepsByName.get(name) ?? []}
            onOpen={() => setOpenIndex(index)}
          />
        ))}
      </div>
      {openIndex !== null ? (
        <VmScreenshotLightbox
          runId={runId}
          names={shown}
          startIndex={openIndex}
          stepsByName={stepsByName}
          onClose={() => setOpenIndex(null)}
        />
      ) : null}
    </section>
  );
}
