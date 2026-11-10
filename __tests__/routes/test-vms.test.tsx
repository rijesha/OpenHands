import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetActiveStoreForTests,
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import type { Backend } from "#/api/backend-registry/types";
import { VmRunPage } from "#/components/features/vm-harness/vm-run-page";
import TestVmsRoute from "#/routes/test-vms";
import { renderWithProviders } from "test-utils";

// Only the edges are faked: the harness's HTTP API, the server-info probe that
// says whether a harness runs, and the conversation launch boundary.

const harness = vi.hoisted(() => ({
  status: vi.fn(),
  settings: vi.fn(),
  saveRoot: vi.fn(),
  browse: vi.fn(),
  listImages: vi.fn(),
  updateImage: vi.fn(),
  deleteImage: vi.fn(),
  unlockImage: vi.fn(),
  lockImage: vi.fn(),
  listLeases: vi.fn(),
  startLease: vi.fn(),
  stopLease: vi.fn(),
  extendLease: vi.fn(),
  snapshotLease: vi.fn(),
  sendInput: vi.fn(),
  leaseScreenshot: vi.fn(),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  deleteRun: vi.fn(),
  runScreenshot: vi.fn(),
  bootFailureShot: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  serverInfo: vi.fn(),
  createConversation: vi.fn(),
}));

const LOCAL: Backend = {
  id: "local-backend",
  name: "local",
  host: "http://localhost:8000",
  apiKey: "key",
  kind: "local",
};

vi.mock("#/contexts/active-backend-context", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("#/contexts/active-backend-context")
  >()),
  useActiveBackend: () => ({ backend: LOCAL, orgId: null }),
}));

vi.mock("#/api/conversation-workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#/api/conversation-workspace")>()),
  getConversationServerInfo: mocks.serverInfo,
}));

vi.mock("#/api/vm-harness-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#/api/vm-harness-service")>()),
  VmHarnessService: harness,
}));

vi.mock("#/hooks/mutation/use-create-conversation", () => ({
  useCreateConversation: () => ({
    mutate: mocks.createConversation,
    isPending: false,
  }),
}));

const STATUS = {
  provider: "hyperv",
  maxVms: 2,
  host: { ok: true, problems: [], freeRamMB: 9000, freeDiskGB: 120 },
  memoryMB: { windows: 6144, ubuntu: 4096 },
  root: String.raw`D:\zide-ai-qa`,
  rootSource: "env",
  imagesDir: String.raw`D:\zide-ai-qa\images`,
  pluginDir: "/state/vm-harness/plugin",
};

const SETTINGS = {
  root: String.raw`D:\zide-ai-qa`,
  rootSource: "env",
  imagesDir: String.raw`D:\zide-ai-qa\images`,
  imageCount: 3,
  hasGuestKey: true,
  runningVms: 0,
};

const BASE = {
  imageId: "win-base",
  os: "windows",
  kind: "golden",
  role: "windows",
  label: "Windows 11",
  locked: true,
  sizeBytes: 28_273_803_264,
  children: ["win-snap"],
};

const SNAPSHOT = {
  imageId: "win-snap",
  os: "windows",
  kind: "prepared",
  label: "Tools installed",
  parentImageId: "win-base",
  baselineRoot: "win-base",
  sizeBytes: 1536,
  children: [],
};

const LEASE = {
  id: "l1a2b3",
  imageId: "win-base",
  os: "windows",
  status: "ready",
  stage: "ready",
  ip: "10.0.0.5",
  startedAt: "2026-11-09T10:00:00Z",
  memoryMB: 6144,
  ttlSecondsLeft: 47 * 60,
  context: { repository: "acme/widgets", item: "7", kind: "pull_request" },
};

const RUN = {
  id: "l000001",
  imageId: "win-base",
  os: "windows",
  startedAt: "2026-11-08T10:00:00Z",
  status: "stopped",
  stage: null,
  error: null,
  hasBootFailureShot: false,
  context: { repository: "acme/widgets", item: "7", kind: "pull_request" },
  report: { passed: true, summary: "All good", steps: 1 },
};

const RUN_DETAIL = {
  lease: {},
  report: { verdict: { passed: true }, summary: "All good" },
  steps: [
    {
      id: "s1",
      title: "Opens the panel",
      status: "pass",
      expected: "A panel",
      observed: "A panel",
      evidence: [String.raw`C:\runs\l000001\screenshots\001-open.png`],
    },
  ],
  screenshots: ["001-open.png"],
};

function withHarness() {
  mocks.serverInfo.mockResolvedValue({
    runtime_services: {
      services: { vm_harness: { plugin_path: "/state/vm-harness/plugin" } },
    },
  });
}

function overview() {
  harness.status.mockResolvedValue(STATUS);
  harness.settings.mockResolvedValue(SETTINGS);
  harness.listImages.mockResolvedValue([BASE, SNAPSHOT]);
  harness.listLeases.mockResolvedValue([LEASE]);
  harness.listRuns.mockResolvedValue([RUN]);
  harness.leaseScreenshot.mockResolvedValue({ pngBase64: "AAAA" });
  harness.runScreenshot.mockResolvedValue({ pngBase64: "AAAA" });
  harness.getRun.mockResolvedValue(RUN_DETAIL);
}

const renderOverview = () =>
  renderWithProviders(
    <MemoryRouter>
      <TestVmsRoute />
    </MemoryRouter>,
    { navigation: { navigate: mocks.navigate } },
  );

beforeEach(() => {
  __resetActiveStoreForTests();
  setRegisteredBackends([LOCAL]);
  setActiveSelection({ backendId: LOCAL.id });
  for (const fn of [...Object.values(harness), ...Object.values(mocks)]) {
    fn.mockReset();
  }
  mocks.serverInfo.mockResolvedValue(null);
  withHarness();
  overview();
});

afterEach(() => {
  __resetActiveStoreForTests();
});

describe("Test VMs page", () => {
  it("explains that the harness is not running when the backend does not advertise it", async () => {
    mocks.serverInfo.mockResolvedValue(null);
    renderOverview();

    expect(await screen.findByTestId("vm-harness-unavailable")).toBeVisible();
    expect(harness.status).not.toHaveBeenCalled();
  });

  it("explains it too when the harness does not answer", async () => {
    harness.status.mockRejectedValue(new Error("connect ECONNREFUSED"));
    renderOverview();

    const card = await screen.findByTestId("vm-harness-unavailable");
    expect(card).toHaveTextContent("connect ECONNREFUSED");
  });

  it("shows the host, running VMs, base images, snapshots and runs", async () => {
    renderOverview();

    expect(await screen.findByTestId("vm-host-status")).toHaveTextContent(
      "VM_HARNESS$HOST_READY",
    );
    expect(await screen.findByTestId("vm-lease-l1a2b3")).toBeVisible();
    const bases = screen.getByTestId("vm-bases");
    expect(within(bases).getByTestId("vm-image-win-base")).toBeVisible();
    const snapshots = screen.getByTestId("vm-snapshots");
    expect(within(snapshots).getByTestId("vm-image-win-snap")).toBeVisible();
    expect(
      within(screen.getByTestId("vm-runs")).getByTestId("vm-run-l000001"),
    ).toBeVisible();
    // Three of the four baselines have no image yet.
    expect(screen.getByTestId("vm-missing-baselines")).toBeVisible();
  });

  it("tells the user where it looked when there are no images", async () => {
    harness.listImages.mockResolvedValue([]);
    renderOverview();

    const bases = await screen.findByTestId("vm-bases");
    expect(bases).toHaveTextContent("VM_HARNESS$BASES_NONE");
    expect(within(bases).queryByTestId("vm-base-change")).toBeNull();
  });

  it("opens a run from the history list", async () => {
    renderOverview();

    await userEvent.click(await screen.findByTestId("vm-run-open-l000001"));
    expect(mocks.navigate).toHaveBeenCalledWith("/test-vms/runs/l000001");
  });

  it("links a run and a running VM back to the GitHub item they were for", async () => {
    renderOverview();

    const lease = await screen.findByTestId("vm-lease-item-l1a2b3");
    await userEvent.click(lease);
    expect(mocks.navigate).toHaveBeenCalledWith(
      "/github?repo=acme%2Fwidgets&item=7&state=all&tab=pulls",
    );
  });
});

describe("Test VMs data folder", () => {
  it("saves a folder typed in the page and says how many images it holds", async () => {
    harness.saveRoot.mockResolvedValue({
      ...SETTINGS,
      root: String.raw`E:\vms`,
      imageCount: 5,
    });
    renderOverview();

    const input = await screen.findByTestId("vm-folder-input");
    await userEvent.clear(input);
    await userEvent.type(input, String.raw`E:\vms`);
    await userEvent.click(screen.getByTestId("vm-folder-save"));

    expect(harness.saveRoot).toHaveBeenCalledWith(String.raw`E:\vms`);
    expect(await screen.findByTestId("vm-folder-saved")).toBeVisible();
  });

  it("shows the harness's reason when it refuses the folder", async () => {
    harness.saveRoot.mockRejectedValue(new Error("Folder not found: E:\\nope"));
    renderOverview();

    await userEvent.click(await screen.findByTestId("vm-folder-save"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Folder not found",
    );
  });

  it("browses the host's folders and puts the chosen one in the field", async () => {
    harness.browse.mockImplementation(async (path: string) =>
      path === ""
        ? { path: "", parent: null, dirs: ["D:\\", "E:\\"] }
        : { path, parent: "", dirs: [], hasImages: true },
    );
    renderOverview();

    // Start from an empty field so the picker opens on the drives.
    const input = await screen.findByTestId("vm-folder-input");
    await userEvent.clear(input);
    await userEvent.click(screen.getByTestId("vm-folder-browse"));
    await userEvent.click(await screen.findByRole("button", { name: "E:\\" }));
    // The picker redraws for the folder it opened, so ask the page again.
    await userEvent.click(await screen.findByText("VM_HARNESS$FOLDER_USE"));

    expect(screen.getByTestId("vm-folder-input")).toHaveValue("E:\\");
  });

  it("is locked while VMs run from the current folder", async () => {
    harness.settings.mockResolvedValue({ ...SETTINGS, runningVms: 1 });
    renderOverview();

    expect(await screen.findByTestId("vm-folder-input")).toBeDisabled();
    expect(screen.getByTestId("vm-folder-save")).toBeDisabled();
  });

  it("warns when the folder has no guest SSH key", async () => {
    harness.settings.mockResolvedValue({ ...SETTINGS, hasGuestKey: false });
    renderOverview();

    expect(
      await screen.findByText("VM_HARNESS$FOLDER_NO_KEY"),
    ).toBeInTheDocument();
  });
});

describe("Test VMs running VMs", () => {
  it("stops, extends and snapshots a running VM, showing its time left", async () => {
    harness.stopLease.mockResolvedValue({ ok: true });
    harness.extendLease.mockResolvedValue({ ok: true });
    harness.snapshotLease.mockResolvedValue({ imageId: "new" });
    renderOverview();

    const card = await screen.findByTestId("vm-lease-l1a2b3");
    expect(within(card).getByTestId("vm-lease-ttl")).toHaveTextContent(
      "VM_HARNESS$TTL",
    );

    await userEvent.click(
      within(card).getByRole("button", { name: "VM_HARNESS$EXTEND" }),
    );
    expect(harness.extendLease).toHaveBeenCalledWith("l1a2b3");

    await userEvent.click(
      within(card).getByRole("button", { name: "VM_HARNESS$SAVE_SNAPSHOT" }),
    );
    await userEvent.type(
      within(card).getByTestId("vm-snapshot-name"),
      "tools-installed",
    );
    await userEvent.click(within(card).getByTestId("vm-snapshot-save"));
    expect(harness.snapshotLease).toHaveBeenCalledWith(
      "l1a2b3",
      "tools-installed",
      "",
    );

    await userEvent.click(within(card).getByTestId("vm-stop-l1a2b3"));
    expect(harness.stopLease).toHaveBeenCalledWith("l1a2b3");
  });

  it("types text and presses a key in a ready VM by hand", async () => {
    harness.sendInput.mockResolvedValue({ ok: true });
    renderOverview();

    const card = await screen.findByTestId("vm-lease-l1a2b3");
    await userEvent.type(
      within(card).getByTestId("vm-type-input"),
      "hello{Enter}",
    );
    expect(harness.sendInput).toHaveBeenCalledWith("l1a2b3", {
      type: "type",
      text: "hello",
    });

    await userEvent.type(
      within(card).getByTestId("vm-key-input"),
      "ctrl+s{Enter}",
    );
    expect(harness.sendInput).toHaveBeenCalledWith("l1a2b3", {
      type: "key",
      combo: "ctrl+s",
    });
  });

  it("offers no manual control while a VM is still booting", async () => {
    harness.listLeases.mockResolvedValue([
      { ...LEASE, status: "booting", stage: "waiting for SSH" },
    ]);
    renderOverview();

    const card = await screen.findByTestId("vm-lease-l1a2b3");
    expect(within(card).queryByTestId("vm-manual-controls")).toBeNull();
  });
});

describe("Test VMs images", () => {
  it("keeps a base locked: it can be started or opened for changes, not edited or deleted", async () => {
    renderOverview();

    const row = await screen.findByTestId("vm-image-win-base");
    expect(within(row).getByTestId("vm-start-win-base")).toBeEnabled();
    expect(
      within(row).getByRole("button", { name: "VM_HARNESS$CHANGE_BASE" }),
    ).toBeVisible();
    expect(within(row).queryByTestId("vm-delete-win-base")).toBeNull();
    expect(
      within(row).queryByRole("button", { name: "BUTTON$EDIT" }),
    ).toBeNull();
  });

  it("offers Edit, Delete and Lock now only while a base is open for changes", async () => {
    harness.listImages.mockResolvedValue([
      {
        ...BASE,
        locked: false,
        unlockedUntil: Date.now() + 30 * 60_000,
        children: [],
      },
    ]);
    harness.lockImage.mockResolvedValue({ ok: true });
    renderOverview();

    const row = await screen.findByTestId("vm-image-win-base");
    expect(within(row).getByTestId("vm-delete-win-base")).toBeVisible();
    expect(
      within(row).getByRole("button", { name: "BUTTON$EDIT" }),
    ).toBeVisible();
    await userEvent.click(
      within(row).getByRole("button", { name: "VM_HARNESS$LOCK_NOW" }),
    );
    expect(harness.lockImage).toHaveBeenCalledWith("win-base");
  });

  it("starts a VM from an image, and stops offering it at the VM limit", async () => {
    harness.startLease.mockResolvedValue(LEASE);
    renderOverview();

    await userEvent.click(await screen.findByTestId("vm-start-win-snap"));
    expect(harness.startLease).toHaveBeenCalledWith("win-snap");
  });

  it("disables Start when as many VMs run as the host allows", async () => {
    harness.status.mockResolvedValue({ ...STATUS, maxVms: 1 });
    renderOverview();

    expect(await screen.findByTestId("vm-start-win-snap")).toBeDisabled();
  });

  it("deletes a snapshot only after a second click, and refuses one an image depends on", async () => {
    harness.deleteImage.mockResolvedValue({});
    harness.listImages.mockResolvedValue([
      { ...BASE, children: [] },
      SNAPSHOT,
      { ...SNAPSHOT, imageId: "parent", label: "Parent", children: ["child"] },
    ]);
    renderOverview();

    const row = await screen.findByTestId("vm-image-win-snap");
    const del = within(row).getByTestId("vm-delete-win-snap");
    await userEvent.click(del);
    expect(harness.deleteImage).not.toHaveBeenCalled();
    await userEvent.click(del);
    expect(harness.deleteImage).toHaveBeenCalledWith("win-snap");

    expect(
      within(screen.getByTestId("vm-image-parent")).getByTestId(
        "vm-delete-parent",
      ),
    ).toBeDisabled();
  });

  it("renames a snapshot", async () => {
    harness.updateImage.mockResolvedValue({ ok: true });
    renderOverview();

    const row = await screen.findByTestId("vm-image-win-snap");
    await userEvent.click(
      within(row).getByRole("button", { name: "BUTTON$EDIT" }),
    );
    const name = within(row).getByLabelText("VM_HARNESS$DISPLAY_NAME");
    await userEvent.clear(name);
    await userEvent.type(name, "Renamed");
    await userEvent.click(
      within(row).getByRole("button", { name: "BUTTON$SAVE" }),
    );

    expect(harness.updateImage).toHaveBeenCalledWith("win-snap", {
      label: "Renamed",
      notes: "",
    });
  });

  it("opens a base and hands the request to an agent from the chat bar", async () => {
    harness.unlockImage.mockResolvedValue({ ok: true });
    mocks.createConversation.mockImplementation((_vars, options) =>
      options.onSuccess({ conversation_id: "conv-1" }),
    );
    renderOverview();

    await userEvent.type(
      await screen.findByTestId("vm-base-request"),
      "Install Node 22",
    );
    await userEvent.click(screen.getByTestId("vm-base-ask"));

    await waitFor(() =>
      expect(harness.unlockImage).toHaveBeenCalledWith("win-base", 60),
    );
    const [variables] = mocks.createConversation.mock.calls[0];
    expect(variables.query).toContain("vm-base-maintenance");
    expect(variables.query).toContain("win-base");
    expect(variables.query).toContain("Install Node 22");
    expect(variables.plugins).toEqual([
      { source: "/state/vm-harness/plugin", name: "gui-vm-testing" },
    ]);
    expect(mocks.navigate).toHaveBeenCalledWith("/conversations/conv-1");
  });

  it("asks for a description before opening anything", async () => {
    renderOverview();

    await userEvent.click(await screen.findByTestId("vm-base-ask"));
    expect(harness.unlockImage).not.toHaveBeenCalled();
    expect(screen.getByText("VM_HARNESS$CHANGE_EMPTY")).toBeVisible();
  });

  it("points the chat bar at the base whose Change button was clicked", async () => {
    harness.listImages.mockResolvedValue([
      BASE,
      {
        ...BASE,
        imageId: "ubu-base",
        os: "ubuntu",
        role: "ubuntu",
        label: "Ubuntu",
      },
    ]);
    renderOverview();

    const row = await screen.findByTestId("vm-image-ubu-base");
    await userEvent.click(
      within(row).getByRole("button", { name: "VM_HARNESS$CHANGE_BASE" }),
    );
    expect(screen.getByTestId("vm-base-select")).toHaveValue("ubu-base");
  });
});

describe("Test VMs run page", () => {
  const renderRun = (runId = "l000001") =>
    renderWithProviders(<VmRunPage runId={runId} />, {
      navigation: { navigate: mocks.navigate },
    });

  it("shows the report, steps and screenshots of a run", async () => {
    renderRun();

    expect(await screen.findByText("All good")).toBeVisible();
    expect(screen.getByTestId("vm-step-s1")).toHaveTextContent(
      "Opens the panel",
    );
    expect(
      await screen.findByTestId("vm-screenshot-001-open.png"),
    ).toBeVisible();
  });

  it("links back to the GitHub item and the Test VMs list", async () => {
    renderRun();

    await userEvent.click(await screen.findByText("acme/widgets#7"));
    expect(mocks.navigate).toHaveBeenCalledWith(
      "/github?repo=acme%2Fwidgets&item=7&state=all&tab=pulls",
    );
    await userEvent.click(screen.getByTestId("vm-run-back"));
    expect(mocks.navigate).toHaveBeenCalledWith("/test-vms");
  });

  it("deletes a run after confirmation and returns to the list", async () => {
    harness.deleteRun.mockResolvedValue({ ok: true });
    renderRun();

    await userEvent.click(await screen.findByTestId("vm-run-delete"));
    expect(harness.deleteRun).not.toHaveBeenCalled();
    await userEvent.click(
      within(screen.getByTestId("confirmation-modal")).getByTestId(
        "confirm-button",
      ),
    );

    await waitFor(() =>
      expect(harness.deleteRun).toHaveBeenCalledWith("l000001"),
    );
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith("/test-vms"),
    );
  });

  it("says so when the run does not exist", async () => {
    renderRun("l999999");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "VM_HARNESS$RUN_NOT_FOUND",
    );
  });
});
