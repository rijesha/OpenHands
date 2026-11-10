import { useParams } from "react-router";
import { VmRunPage } from "#/components/features/vm-harness/vm-run-page";

export default function TestVmRunRoute() {
  const { runId = "" } = useParams();
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <VmRunPage runId={runId} />
    </div>
  );
}
