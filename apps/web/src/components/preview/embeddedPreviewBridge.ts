import type {
  DesktopPreviewAutomationStatus,
  DesktopPreviewBridge,
  DesktopPreviewColorScheme,
  DesktopPreviewTabDefaults,
  DesktopPreviewTabState,
  DesktopPreviewWebviewConfig,
  EnvironmentId,
  PreviewAutomationSnapshot,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";

/**
 * The Rearvy shell embeds the T3 web client in an iframe, so T3's desktop
 * preload cannot be installed in that document. Electron still gives the
 * top-level Rearvy window an isolated `<webview>` capability, though. This
 * bridge owns the small renderer-side adapter needed to use that capability
 * without exposing Node or IPC to the guest page.
 *
 * The standalone T3 desktop client continues to use its main-process preview
 * manager. This adapter is only constructed for the explicitly embedded
 * Electron runtime selected in `previewBridge.ts`.
 */

const PREVIEW_WEBVIEW_PREFERENCES = "contextIsolation=true,sandbox=true,nodeIntegration=false";
const DEFAULT_ZOOM_FACTOR = 1;
const ZOOM_LEVELS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
] as const;

type EmbeddedWebviewEvent = Event & {
  readonly url?: unknown;
  readonly title?: unknown;
  readonly errorCode?: unknown;
  readonly errorDescription?: unknown;
  readonly validatedURL?: unknown;
  readonly isMainFrame?: unknown;
  readonly audible?: unknown;
};

type EmbeddedWebview = HTMLElement & {
  readonly getURL?: () => string;
  readonly getTitle?: () => string;
  readonly isLoading?: () => boolean;
  readonly canGoBack?: () => boolean;
  readonly canGoForward?: () => boolean;
  readonly loadURL?: (url: string) => Promise<void>;
  readonly goBack?: () => void;
  readonly goForward?: () => void;
  readonly reload?: () => void;
  readonly reloadIgnoringCache?: () => void;
  readonly openDevTools?: () => void;
  readonly setZoomFactor?: (factor: number) => void;
  readonly setAudioMuted?: (muted: boolean) => void;
  readonly isCurrentlyAudible?: () => boolean;
};

interface EmbeddedTab {
  state: DesktopPreviewTabState;
  webview: EmbeddedWebview | null;
  pendingUrl: string | null;
  removeListeners: (() => void)[];
}

type StateListener = (tabId: string, state: DesktopPreviewTabState) => void;

const unsupported = async <T>(operation: string): Promise<T> => {
  throw new Error(`Embedded browser does not support ${operation} in Rearvy Desktop.`);
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeZoomFactor(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_ZOOM_FACTOR;
  return ZOOM_LEVELS.reduce((closest, level) =>
    Math.abs(level - value) < Math.abs(closest - value) ? level : closest,
  );
}

function nextZoomFactor(current: number, direction: "in" | "out"): number {
  const index = ZOOM_LEVELS.findIndex(
    (level) => Math.abs(level - current) < 0.001 || level > current,
  );
  const currentIndex = index < 0 ? ZOOM_LEVELS.length - 1 : index;
  const exactIndex =
    Math.abs(ZOOM_LEVELS[currentIndex]! - current) < 0.001
      ? currentIndex
      : Math.max(0, currentIndex - 1);
  return ZOOM_LEVELS[
    direction === "in"
      ? Math.min(exactIndex + 1, ZOOM_LEVELS.length - 1)
      : Math.max(exactIndex - 1, 0)
  ]!;
}

function isBlankUrl(url: string): boolean {
  return url === "" || url === "about:blank";
}

function readWebviewUrl(webview: EmbeddedWebview): string {
  try {
    return webview.getURL?.() || "";
  } catch {
    return "";
  }
}

function readWebviewTitle(webview: EmbeddedWebview): string {
  try {
    return webview.getTitle?.() || "";
  } catch {
    return "";
  }
}

function readCanGoBack(webview: EmbeddedWebview): boolean {
  try {
    return webview.canGoBack?.() ?? false;
  } catch {
    return false;
  }
}

function readCanGoForward(webview: EmbeddedWebview): boolean {
  try {
    return webview.canGoForward?.() ?? false;
  } catch {
    return false;
  }
}

function readAudible(webview: EmbeddedWebview): boolean {
  try {
    return webview.isCurrentlyAudible?.() ?? false;
  } catch {
    return false;
  }
}

function findWebview(tabId: string): EmbeddedWebview | null {
  if (typeof document === "undefined") return null;
  return (
    Array.from(document.querySelectorAll<EmbeddedWebview>("webview[data-preview-tab]")).find(
      (candidate) => candidate.getAttribute("data-preview-tab") === tabId,
    ) ?? null
  );
}

function fallbackEnvironmentPartitionHash(environmentId: string): string {
  // Two independent 32-bit FNV passes give a stable, bounded partition name
  // without putting tenant/environment identifiers into Chromium storage
  // paths. The browser session remains scoped per environment.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < environmentId.length; index += 1) {
    const code = environmentId.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}-${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

async function environmentPartitionHash(environmentId: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(environmentId),
    );
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 20);
  }
  return fallbackEnvironmentPartitionHash(environmentId);
}

function createInitialState(
  tabId: string,
  defaults?: DesktopPreviewTabDefaults,
): DesktopPreviewTabState {
  return {
    tabId,
    webContentsId: null,
    navStatus: { kind: "Idle" },
    canGoBack: false,
    canGoForward: false,
    zoomFactor: normalizeZoomFactor(defaults?.zoomFactor),
    pictureInPicture: false,
    colorScheme: defaults?.colorScheme ?? "system",
    audioMuted: false,
    audible: false,
    controller: "none",
    updatedAt: nowIso(),
  };
}

function createUnavailableAutomationStatus(): DesktopPreviewAutomationStatus {
  return {
    available: false,
    visible: false,
    tabId: null,
    url: null,
    title: null,
    loading: false,
  };
}

function createEmbeddedPreviewBridge(): DesktopPreviewBridge {
  const tabs = new Map<string, EmbeddedTab>();
  const stateListeners = new Set<StateListener>();
  const configCache = new Map<string, Promise<DesktopPreviewWebviewConfig>>();

  const emit = (tabId: string): void => {
    const tab = tabs.get(tabId);
    if (!tab) return;
    for (const listener of stateListeners) listener(tabId, tab.state);
  };

  const update = (
    tabId: string,
    patch: Partial<DesktopPreviewTabState>,
  ): DesktopPreviewTabState => {
    const tab = tabs.get(tabId);
    if (!tab) throw new Error(`Embedded preview tab not found: ${tabId}`);
    tab.state = { ...tab.state, ...patch, updatedAt: nowIso() };
    emit(tabId);
    return tab.state;
  };

  const requireTab = (tabId: string): EmbeddedTab => {
    const tab = tabs.get(tabId);
    if (!tab) throw new Error(`Embedded preview tab not found: ${tabId}`);
    return tab;
  };

  const removeWebviewListeners = (tab: EmbeddedTab): void => {
    for (const remove of tab.removeListeners) remove();
    tab.removeListeners = [];
  };

  const syncNavigation = (tabId: string, webview: EmbeddedWebview): void => {
    const tab = tabs.get(tabId);
    if (!tab || tab.webview !== webview) return;
    const url = readWebviewUrl(webview);
    const title = readWebviewTitle(webview);
    const pendingUrl = tab.pendingUrl;
    tab.pendingUrl = null;
    if (isBlankUrl(url) && !pendingUrl) {
      update(tabId, {
        navStatus: { kind: "Idle" },
        canGoBack: readCanGoBack(webview),
        canGoForward: readCanGoForward(webview),
      });
      return;
    }
    update(tabId, {
      navStatus: {
        kind: "Success",
        url: isBlankUrl(url) ? (pendingUrl ?? "about:blank") : url,
        title,
      },
      canGoBack: readCanGoBack(webview),
      canGoForward: readCanGoForward(webview),
      audible: readAudible(webview),
    });
  };

  const attachWebview = (tabId: string, webview: EmbeddedWebview, webContentsId: number): void => {
    const tab = requireTab(tabId);
    removeWebviewListeners(tab);
    tab.webview = webview;

    const listen = (name: string, handler: (event: EmbeddedWebviewEvent) => void): void => {
      const wrapped = handler as EventListener;
      webview.addEventListener(name, wrapped);
      tab.removeListeners.push(() => webview.removeEventListener(name, wrapped));
    };

    listen("did-start-loading", () => {
      const url = tab.pendingUrl ?? readWebviewUrl(webview);
      if (isBlankUrl(url)) return;
      update(tabId, {
        navStatus: {
          kind: "Loading",
          url,
          title: tab.state.navStatus.kind === "Idle" ? "" : tab.state.navStatus.title,
        },
      });
    });
    listen("did-stop-loading", () => syncNavigation(tabId, webview));
    listen("did-navigate", (event) => {
      if (typeof event.url === "string" && !isBlankUrl(event.url)) tab.pendingUrl = event.url;
      update(tabId, {
        canGoBack: readCanGoBack(webview),
        canGoForward: readCanGoForward(webview),
      });
    });
    listen("did-navigate-in-page", (event) => {
      if (typeof event.url === "string" && !isBlankUrl(event.url)) tab.pendingUrl = event.url;
      syncNavigation(tabId, webview);
    });
    listen("page-title-updated", (event) => {
      const current = tab.state.navStatus;
      if (current.kind === "Idle") return;
      update(tabId, {
        navStatus: { ...current, title: typeof event.title === "string" ? event.title : "" },
      });
    });
    listen("audio-state-changed", (event) => {
      update(tabId, {
        audible: typeof event.audible === "boolean" ? event.audible : readAudible(webview),
      });
    });
    listen("did-fail-load", (event) => {
      if (event.isMainFrame === false) return;
      const url =
        (typeof event.validatedURL === "string" && event.validatedURL) ||
        tab.pendingUrl ||
        readWebviewUrl(webview) ||
        "about:blank";
      tab.pendingUrl = null;
      update(tabId, {
        navStatus: {
          kind: "LoadFailed",
          url,
          title: readWebviewTitle(webview),
          code: typeof event.errorCode === "number" ? event.errorCode : -1,
          description:
            typeof event.errorDescription === "string"
              ? event.errorDescription
              : "The page could not be loaded.",
        },
        canGoBack: readCanGoBack(webview),
        canGoForward: readCanGoForward(webview),
      });
    });
    listen("render-process-gone", () => {
      tab.webview = null;
      removeWebviewListeners(tab);
      update(tabId, { webContentsId: null, audible: false });
    });

    const url = readWebviewUrl(webview);
    const loading = webview.isLoading?.() ?? false;
    update(tabId, {
      webContentsId,
      navStatus:
        tab.pendingUrl || (loading && !isBlankUrl(url))
          ? {
              kind: "Loading",
              url: tab.pendingUrl ?? url,
              title: tab.state.navStatus.kind === "Idle" ? "" : tab.state.navStatus.title,
            }
          : isBlankUrl(url)
            ? { kind: "Idle" }
            : { kind: "Success", url, title: readWebviewTitle(webview) },
      canGoBack: readCanGoBack(webview),
      canGoForward: readCanGoForward(webview),
      audible: readAudible(webview),
    });

    if (tab.pendingUrl && url !== tab.pendingUrl && webview.loadURL) {
      const pendingUrl = tab.pendingUrl;
      void webview.loadURL(pendingUrl).catch((error) => {
        const current = tabs.get(tabId);
        if (!current || current.webview !== webview) return;
        current.pendingUrl = null;
        update(tabId, {
          navStatus: {
            kind: "LoadFailed",
            url: pendingUrl,
            title: "",
            code: -1,
            description: error instanceof Error ? error.message : "The page could not be loaded.",
          },
        });
      });
    }
  };

  const requireWebview = (tabId: string): { tab: EmbeddedTab; webview: EmbeddedWebview } => {
    const tab = requireTab(tabId);
    if (!tab.webview) throw new Error(`Embedded preview tab is not attached: ${tabId}`);
    return { tab, webview: tab.webview };
  };

  const getPreviewConfig = async (
    environmentId: EnvironmentId,
  ): Promise<DesktopPreviewWebviewConfig> => {
    const key = String(environmentId);
    const cached = configCache.get(key);
    if (cached) return cached;
    const config = environmentPartitionHash(key).then((hash) => ({
      partition: `persist:rearvy-t3-preview-${hash}`,
      webPreferences: PREVIEW_WEBVIEW_PREFERENCES,
      // The embedded bridge is renderer-owned; no arbitrary preload is sent
      // into pages visited by the browser surface.
      preloadUrl: null,
    }));
    configCache.set(key, config);
    return config;
  };

  const bridge: DesktopPreviewBridge = {
    createTab: async (tabId, defaults) => {
      if (tabs.has(tabId)) return;
      const state = createInitialState(tabId, defaults);
      tabs.set(tabId, { state, webview: null, pendingUrl: null, removeListeners: [] });
      emit(tabId);
    },
    closeTab: async (tabId) => {
      const tab = tabs.get(tabId);
      if (!tab) return;
      removeWebviewListeners(tab);
      tabs.delete(tabId);
    },
    registerWebview: async (tabId, webContentsId) => {
      const webview = findWebview(tabId);
      if (!webview) throw new Error(`Embedded preview webview is not mounted: ${tabId}`);
      attachWebview(tabId, webview, webContentsId);
    },
    navigate: async (tabId, rawUrl) => {
      const { tab, webview } = requireWebview(tabId);
      const url = normalizePreviewUrl(rawUrl);
      tab.pendingUrl = url;
      update(tabId, {
        navStatus: {
          kind: "Loading",
          url,
          title: tab.state.navStatus.kind === "Idle" ? "" : tab.state.navStatus.title,
        },
      });
      if (!webview.loadURL) throw new Error("Embedded preview webview cannot navigate.");
      await webview.loadURL(url);
    },
    goBack: async (tabId) => {
      const { webview } = requireWebview(tabId);
      if (webview.canGoBack?.()) webview.goBack?.();
    },
    goForward: async (tabId) => {
      const { webview } = requireWebview(tabId);
      if (webview.canGoForward?.()) webview.goForward?.();
    },
    refresh: async (tabId) => {
      const { webview } = requireWebview(tabId);
      webview.reload?.();
    },
    zoomIn: async (tabId) => {
      const { tab, webview } = requireWebview(tabId);
      const next = nextZoomFactor(tab.state.zoomFactor, "in");
      webview.setZoomFactor?.(next);
      update(tabId, { zoomFactor: next });
    },
    zoomOut: async (tabId) => {
      const { tab, webview } = requireWebview(tabId);
      const next = nextZoomFactor(tab.state.zoomFactor, "out");
      webview.setZoomFactor?.(next);
      update(tabId, { zoomFactor: next });
    },
    resetZoom: async (tabId) => {
      const { webview } = requireWebview(tabId);
      webview.setZoomFactor?.(DEFAULT_ZOOM_FACTOR);
      update(tabId, { zoomFactor: DEFAULT_ZOOM_FACTOR });
    },
    hardReload: async (tabId) => {
      const { webview } = requireWebview(tabId);
      webview.reloadIgnoringCache?.();
    },
    setColorScheme: async (tabId, colorScheme: DesktopPreviewColorScheme) => {
      requireTab(tabId);
      // Keep the state contract coherent in the embedded renderer. The
      // advanced appearance menu is intentionally hidden for this adapter
      // because it cannot emulate Chromium's media feature without a main
      // process control session.
      update(tabId, { colorScheme });
    },
    setAudioMuted: async (tabId, audioMuted) => {
      const { webview } = requireWebview(tabId);
      webview.setAudioMuted?.(audioMuted);
      update(tabId, { audioMuted });
    },
    openDevTools: async (tabId) => {
      const { webview } = requireWebview(tabId);
      webview.openDevTools?.();
    },
    clearCookies: () => unsupported("clearing browser cookies"),
    clearCache: () => unsupported("clearing browser cache"),
    getPreviewConfig,
    setAnnotationTheme: async () => undefined,
    pickElement: () => unsupported("element picking"),
    cancelPickElement: async () => undefined,
    captureScreenshot: () => unsupported("browser screenshots"),
    revealArtifact: () => unsupported("revealing browser artifacts"),
    copyArtifactToClipboard: () => unsupported("copying browser artifacts"),
    pictureInPicture: {
      open: () => unsupported("separate preview windows"),
      close: () => unsupported("separate preview windows"),
    },
    recording: {
      startScreencast: () => unsupported("browser recording"),
      stopScreencast: () => unsupported("browser recording"),
      save: () => unsupported("browser recording"),
      onFrame: () => () => undefined,
    },
    automation: {
      status: async () => createUnavailableAutomationStatus(),
      snapshot: () => unsupported<PreviewAutomationSnapshot>("browser automation snapshots"),
      click: () => unsupported("browser automation clicks"),
      type: () => unsupported("browser automation typing"),
      press: () => unsupported("browser automation key presses"),
      scroll: () => unsupported("browser automation scrolling"),
      evaluate: () => unsupported("browser automation evaluation"),
      waitFor: () => unsupported("browser automation waits"),
    },
    onStateChange: (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    // Electron does not route mouse events from a `<webview>` to the embedder,
    // so the embedded adapter has no pointer stream to publish.
    onPointerEvent: () => () => undefined,
  };

  return bridge;
}

export const embeddedPreviewBridge = createEmbeddedPreviewBridge;
