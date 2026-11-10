import React from "react";
import { useTranslation } from "react-i18next";
import type { VmHarnessImage } from "#/api/vm-harness-service";
import { useNavigation } from "#/context/navigation-context";
import { useCreateConversation } from "#/hooks/mutation/use-create-conversation";
import { useUnlockVmImage } from "#/hooks/mutation/use-vm-harness-mutations";
import { useVmHarness } from "#/hooks/query/use-vm-harness";
import { I18nKey } from "#/i18n/declaration";
import { buildGuiVmPlugin } from "#/utils/gui-vm-launch";
import {
  VmActionError,
  VmButton,
  vmCardClassName,
  vmInputClassName,
} from "./vm-ui";

/** The base opens for this long: enough for an agent to install tools and save a revision. */
const UNLOCK_MINUTES = 60;
const MAX_REQUEST_CHARS = 300;

interface VmBaseChangeBarProps {
  bases: VmHarnessImage[];
  /** The base the form targets; "Change this base…" on a row sets it. */
  baseId: string;
  onBaseChange: (imageId: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

/**
 * Describe a change to a base image. The base is opened for an hour and an
 * agent conversation with the VM tools makes the change in a VM; the result is
 * saved as a new revision, so the current base is never modified.
 */
export function VmBaseChangeBar({
  bases,
  baseId,
  onBaseChange,
  inputRef,
}: VmBaseChangeBarProps) {
  const { t } = useTranslation("openhands");
  const { navigate } = useNavigation();
  const { pluginPath } = useVmHarness();
  const unlock = useUnlockVmImage();
  const { mutate: createConversation, isPending: isStarting } =
    useCreateConversation();
  const [request, setRequest] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);

  const submit = () => {
    const text = request.trim();
    if (!text) {
      setProblem(t(I18nKey.VM_HARNESS$CHANGE_EMPTY));
      return;
    }
    if (!pluginPath) return;
    setProblem(null);
    unlock.mutate(
      { imageId: baseId, minutes: UNLOCK_MINUTES },
      {
        onSuccess: () =>
          createConversation(
            {
              query: `Use the vm-base-maintenance skill to change base image ${baseId}: ${text}`,
              plugins: [buildGuiVmPlugin(pluginPath)],
              entryPoint: "test_vms_base_change",
            },
            {
              onSuccess: (data) =>
                navigate(`/conversations/${data.conversation_id}`),
            },
          ),
      },
    );
  };

  return (
    <div
      data-testid="vm-base-change"
      className={`${vmCardClassName} border-dashed`}
    >
      <strong className="text-sm text-contrast">
        {t(I18nKey.VM_HARNESS$CHANGE_TITLE)}
      </strong>
      <p className="text-xs text-muted">{t(I18nKey.VM_HARNESS$CHANGE_HELP)}</p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <select
          value={baseId}
          data-testid="vm-base-select"
          aria-label={t(I18nKey.VM_HARNESS$CHANGE_SELECT)}
          onChange={(event) => onBaseChange(event.target.value)}
          className={`${vmInputClassName} max-w-60`}
        >
          {bases.map((base) => (
            <option key={base.imageId} value={base.imageId}>
              {base.label || base.imageId}
            </option>
          ))}
        </select>
        <input
          ref={inputRef}
          type="text"
          maxLength={MAX_REQUEST_CHARS}
          value={request}
          data-testid="vm-base-request"
          aria-label={t(I18nKey.VM_HARNESS$CHANGE_INPUT)}
          placeholder={t(I18nKey.VM_HARNESS$CHANGE_PLACEHOLDER)}
          onChange={(event) => setRequest(event.target.value)}
          className={`${vmInputClassName} min-w-48 flex-1`}
        />
        <VmButton
          type="submit"
          data-testid="vm-base-ask"
          disabled={unlock.isPending || isStarting || !pluginPath}
        >
          {t(I18nKey.VM_HARNESS$CHANGE_ASK)}
        </VmButton>
      </form>
      {problem ? <p className="text-xs text-danger">{problem}</p> : null}
      <VmActionError error={unlock.error} />
    </div>
  );
}
