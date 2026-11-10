import React from "react";
import { cn } from "#/utils/utils";

export const vmCardClassName =
  "flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-base-secondary p-4";

export const vmInputClassName =
  "h-9 min-w-0 rounded-md border border-border bg-canvas-base px-2 text-sm text-contrast placeholder:text-tertiary-alt";

const smallButtonClassName =
  "inline-flex h-8 cursor-pointer items-center justify-center rounded-md border border-border bg-base-secondary px-2.5 text-xs text-contrast hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40";

interface VmButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: "default" | "danger";
}

/** The compact button used in rows and cards of the Test VMs page. */
export function VmButton({
  tone = "default",
  className,
  type = "button",
  ...props
}: VmButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        smallButtonClassName,
        tone === "danger" && "border-danger text-danger",
        className,
      )}
      {...props}
    />
  );
}

/** The harness's reason for a refused action, under the control that sent it. */
export function VmActionError({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p role="alert" className="text-xs text-danger wrap-anywhere">
      {message}
    </p>
  );
}

export function VmCard({
  title,
  description,
  children,
  testId,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section data-testid={testId} className={vmCardClassName}>
      {title ? (
        <h2 className="text-sm font-semibold text-contrast">{title}</h2>
      ) : null}
      {description ? <p className="text-xs text-muted">{description}</p> : null}
      {children}
    </section>
  );
}
