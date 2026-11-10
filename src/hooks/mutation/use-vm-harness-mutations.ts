import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  VmHarnessService,
  type VmHarnessDesktopAction,
} from "#/api/vm-harness-service";
import { VM_HARNESS_QUERY_KEYS } from "#/hooks/query/query-keys";

/**
 * Writes to the VM harness. Each one refreshes every harness query afterwards:
 * a lease change moves images (in use), runs and status together. Errors stay
 * on the mutation so the control that started it can show the harness's reason.
 */
function useHarnessMutation<TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  { refresh = true }: { refresh?: boolean } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    meta: { disableToast: true },
    onSettled: () => {
      if (!refresh) return undefined;
      return queryClient.invalidateQueries({
        queryKey: VM_HARNESS_QUERY_KEYS.root,
      });
    },
  });
}

export const useSaveVmHarnessRoot = () =>
  useHarnessMutation((root: string) => VmHarnessService.saveRoot(root));

export const useStartVmLease = () =>
  useHarnessMutation((image: string) => VmHarnessService.startLease(image));

export const useStopVmLease = () =>
  useHarnessMutation((leaseId: string) => VmHarnessService.stopLease(leaseId));

export const useExtendVmLease = () =>
  useHarnessMutation((leaseId: string) =>
    VmHarnessService.extendLease(leaseId),
  );

export const useSnapshotVmLease = () =>
  useHarnessMutation(
    (variables: { leaseId: string; name: string; notes: string }) =>
      VmHarnessService.snapshotLease(
        variables.leaseId,
        variables.name,
        variables.notes,
      ),
  );

/** A click, typed text or key sent to a VM by hand. The live screen refreshes on its own. */
export const useSendVmInput = () =>
  useHarnessMutation(
    (variables: { leaseId: string; action: VmHarnessDesktopAction }) =>
      VmHarnessService.sendInput(variables.leaseId, variables.action),
    { refresh: false },
  );

export const useUpdateVmImage = () =>
  useHarnessMutation(
    (variables: { imageId: string; label: string; notes: string }) =>
      VmHarnessService.updateImage(variables.imageId, {
        label: variables.label,
        notes: variables.notes,
      }),
  );

export const useDeleteVmImage = () =>
  useHarnessMutation((imageId: string) =>
    VmHarnessService.deleteImage(imageId),
  );

export const useUnlockVmImage = () =>
  useHarnessMutation((variables: { imageId: string; minutes: number }) =>
    VmHarnessService.unlockImage(variables.imageId, variables.minutes),
  );

export const useLockVmImage = () =>
  useHarnessMutation((imageId: string) => VmHarnessService.lockImage(imageId));

export const useDeleteVmRun = () =>
  useHarnessMutation((runId: string) => VmHarnessService.deleteRun(runId));
