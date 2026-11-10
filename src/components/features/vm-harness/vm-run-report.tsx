import { useTranslation } from "react-i18next";
import type {
  VmHarnessReport,
  VmHarnessStep,
  VmHarnessStepStatus,
} from "#/api/vm-harness-service";
import { I18nKey } from "#/i18n/declaration";
import { cn } from "#/utils/utils";

const STEP_LABEL: Record<VmHarnessStepStatus, I18nKey> = {
  pass: I18nKey.VM_HARNESS$STEP_PASS,
  fail: I18nKey.VM_HARNESS$STEP_FAIL,
  blocked: I18nKey.VM_HARNESS$STEP_BLOCKED,
  skipped: I18nKey.VM_HARNESS$STEP_SKIPPED,
};

export const stepTone = (status: VmHarnessStepStatus): string => {
  if (status === "pass") return "text-success";
  if (status === "fail") return "text-danger";
  return "text-muted";
};

/** One recorded test step: its result and what was expected against what was seen. */
export function VmStep({ step }: { step: VmHarnessStep }) {
  const { t } = useTranslation("openhands");
  return (
    <div data-testid={`vm-step-${step.id}`} className="flex flex-col gap-0.5">
      <div className="text-sm text-contrast">
        <span className={cn("mr-2 font-medium", stepTone(step.status))}>
          {t(STEP_LABEL[step.status] ?? I18nKey.VM_HARNESS$STEP_SKIPPED)}
        </span>
        <span className="wrap-anywhere">
          {step.id} {step.title}
        </span>
      </div>
      <div className="text-xs text-muted wrap-anywhere">
        {t(I18nKey.VM_HARNESS$STEP_DETAIL, {
          expected: step.expected,
          observed: step.observed,
        })}
      </div>
    </div>
  );
}

interface VmRunReportProps {
  report: VmHarnessReport | null;
  steps: VmHarnessStep[];
}

/** What the agent concluded in a VM run and the steps behind it. */
export function VmRunReport({ report, steps }: VmRunReportProps) {
  const { t } = useTranslation("openhands");

  return (
    <div data-testid="vm-run-report" className="flex flex-col gap-3">
      {report ? (
        <div className="flex flex-col gap-1">
          <span
            className={cn(
              "text-sm font-medium",
              report.verdict.passed ? "text-success" : "text-danger",
            )}
          >
            {t(
              report.verdict.passed
                ? I18nKey.GITHUB$VM_RUN_PASSED
                : I18nKey.GITHUB$VM_RUN_FAILED,
            )}
          </span>
          <p className="whitespace-pre-wrap text-sm text-contrast wrap-anywhere">
            {report.summary}
          </p>
          {(report.envProblems ?? []).map((problem) => (
            <p key={problem} className="text-xs text-muted wrap-anywhere">
              {t(I18nKey.VM_HARNESS$ENV_PROBLEM, { problem })}
            </p>
          ))}
        </div>
      ) : (
        <p className="text-sm italic text-muted">
          {t(I18nKey.VM_HARNESS$RUN_NO_REPORT)}
        </p>
      )}
      {steps.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-semibold text-contrast">
            {t(I18nKey.VM_HARNESS$STEPS, { count: steps.length })}
          </h4>
          <ul className="flex flex-col gap-2">
            {steps.map((step) => (
              <li key={step.id}>
                <VmStep step={step} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
