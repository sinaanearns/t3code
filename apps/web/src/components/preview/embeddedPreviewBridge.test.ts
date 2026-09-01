import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { embeddedPreviewBridge } from "./embeddedPreviewBridge";

type FakeWebview = {
  addEventListener: (name: string, listener: EventListener) => void;
  removeEventListener: (name: string, listener: EventListener) => void;
  getAttribute: (name: string) => string | null;
  getURL: () => string;
  getTitle: () => string;
  isLoading: () => boolean;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  getWebContentsId: () => number;
  loadURL: (url: string) => Promise<void>;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  reloadIgnoringCache: () => void;
  openDevTools: () => void;
  setZoomFactor: (factor: number) => void;
  setAudioMuted: (muted: boolean) => void;
  isCurrentlyAudible: () => boolean;
};

const listeners = new Map<string, Set<EventListener>>();
let currentUrl = "about:blank";
let currentTitle = "";
let currentZoom = 1;
let currentMuted = false;

const fakeWebview: FakeWebview = {
  addEventListener: (name, listener) => {
    const current = listeners.get(name) ?? new Set<EventListener>();
    current.add(listener);
    listeners.set(name, current);
  },
  removeEventListener: (name, listener) => listeners.get(name)?.delete(listener),
  getAttribute: (name) => (name === "data-preview-tab" ? "runtime-tab" : null),
  getURL: () => currentUrl,
  getTitle: () => currentTitle,
  isLoading: () => false,
  canGoBack: () => false,
  canGoForward: () => false,
  getWebContentsId: () => 41,
  loadURL: async (url) => {
    currentUrl = url;
  },
  goBack: vi.fn(),
  goForward: vi.fn(),
  reload: vi.fn(),
  reloadIgnoringCache: vi.fn(),
  openDevTools: vi.fn(),
  setZoomFactor: (factor) => {
    currentZoom = factor;
  },
  setAudioMuted: (muted) => {
    currentMuted = muted;
  },
  isCurrentlyAudible: () => false,
};

function dispatch(name: string, event: Partial<Event> = {}): void {
  for (const listener of listeners.get(name) ?? []) listener(event as Event);
}

afterEach(() => {
  listeners.clear();
  currentUrl = "about:blank";
  currentTitle = "";
  currentZoom = 1;
  currentMuted = false;
  vi.unstubAllGlobals();
});

describe("embeddedPreviewBridge", () => {
  it("keeps the Browser surface available through an isolated renderer webview", async () => {
    vi.stubGlobal("document", {
      querySelectorAll: () => [fakeWebview],
    });

    const bridge = embeddedPreviewBridge();
    const changes: Array<{
      tabId: string;
      state: { navStatus: { kind: string }; zoomFactor: number };
    }> = [];
    bridge.onStateChange((tabId, state) => changes.push({ tabId, state }));

    await bridge.createTab("runtime-tab", { zoomFactor: 1.25 });
    await bridge.registerWebview("runtime-tab", 41);
    await bridge.navigate("runtime-tab", "localhost:3000");
    currentTitle = "Rearvy local app";
    dispatch("did-stop-loading");
    await bridge.zoomIn("runtime-tab");
    await bridge.setAudioMuted("runtime-tab", true);

    expect(changes.at(-1)).toMatchObject({
      tabId: "runtime-tab",
      state: {
        navStatus: { kind: "Success", url: "http://localhost:3000/", title: "Rearvy local app" },
        zoomFactor: 1.5,
        audioMuted: true,
        webContentsId: 41,
      },
    });
    expect(currentZoom).toBe(1.5);
    expect(currentMuted).toBe(true);
  });

  it("derives stable environment-scoped browser configuration", async () => {
    const bridge = embeddedPreviewBridge();
    const first = await bridge.getPreviewConfig("environment-a" as never);
    const second = await bridge.getPreviewConfig("environment-a" as never);
    const other = await bridge.getPreviewConfig("environment-b" as never);

    expect(first).toEqual(second);
    expect(first.partition).toMatch(
      /^persist:rearvy-t3-preview-(?:[0-9a-f]{20}|[0-9a-f]{8}-[0-9a-f]{8})$/,
    );
    expect(first.partition).not.toBe(other.partition);
    expect(first.webPreferences).toBe("contextIsolation=true,sandbox=true,nodeIntegration=false");
    expect(first.preloadUrl).toBeNull();
  });
});
