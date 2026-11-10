import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { useVmHarnessCapacity } from "#/hooks/query/use-vm-harness";
import { cn } from "#/utils/utils";
import {
  GUI_VM_TARGETS,
  guiVmTargetOs,
  isGuiVmTarget,
  type GuiVmTarget,
} from "#/utils/gui-vm-launch";

/** `undefined` means the default sandbox. */
export type TestEnvironment = GuiVmTarget | undefined;

const SANDBOX = "sandbox";

const TARGET_LABEL: Record<GuiVmTarget, I18nKey> = {
  windows: I18nKey.GITHUB$TEST_ENV_VM_WINDOWS,
  "windows-workspace": I18nKey.GITHUB$TEST_ENV_VM_WINDOWS_WORKSPACE,
  ubuntu: I18nKey.GITHUB$TEST_ENV_VM_UBUNTU,
  "ubuntu-workspace": I18nKey.GITHUB$TEST_ENV_VM_UBUNTU_WORKSPACE,
};

interface TestEnvironmentSelectProps {
  value: TestEnvironment;
  onChange: (value: TestEnvironment) => void;
  isDisabled?: boolean;
  /** Inline in a toolbar: the label is read by assistive tech only and the hint is dropped. */
  compact?: boolean;
}

/**
 * Where the agent verifies its work: the default sandbox, or a full-GUI VM
 * leased from the VM harness. Render it only when the backend runs a harness.
 */
export function TestEnvironmentSelect({
  value,
  onChange,
  isDisabled,
  compact = false,
}: TestEnvironmentSelectProps) {
  const { t } = useTranslation("openhands");
  const { hasImageFor, memoryShortfall } = useVmHarnessCapacity();
  const shortfall = value ? memoryShortfall(guiVmTargetOs(value)) : null;

  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor="test-environment-select"
        className={compact ? "sr-only" : "text-xs font-medium text-contrast"}
      >
        {t(I18nKey.GITHUB$TEST_ENVIRONMENT)}
      </label>
      <select
        id="test-environment-select"
        data-testid="test-environment-select"
        value={value ?? SANDBOX}
        disabled={isDisabled}
        onChange={(event) =>
          onChange(
            isGuiVmTarget(event.target.value) ? event.target.value : undefined,
          )
        }
        className={cn(
          "h-9 rounded-md border border-border bg-base-secondary px-2 text-sm text-contrast",
          compact ? "max-w-48" : "w-full sm:w-72",
        )}
      >
        <option value={SANDBOX}>{t(I18nKey.GITHUB$TEST_ENV_SANDBOX)}</option>
        {GUI_VM_TARGETS.map((target) => {
          // Only a known absence disables an option; while the list loads it stays choosable.
          const missing = hasImageFor(target) === false;
          return (
            <option key={target} value={target} disabled={missing}>
              {missing
                ? t(I18nKey.GITHUB$TEST_ENV_NO_IMAGE, {
                    label: t(TARGET_LABEL[target]),
                  })
                : t(TARGET_LABEL[target])}
            </option>
          );
        })}
      </select>
      {shortfall ? (
        <p
          role="status"
          data-testid="test-environment-low-ram"
          className="text-xs text-danger"
        >
          {t(I18nKey.GITHUB$TEST_ENV_LOW_RAM, shortfall)}
        </p>
      ) : null}
      {compact ? null : (
        <p className="text-xs text-muted">{t(I18nKey.GITHUB$TEST_ENV_HINT)}</p>
      )}
    </div>
  );
}
