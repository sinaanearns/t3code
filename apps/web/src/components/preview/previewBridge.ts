import type { DesktopPreviewBridge } from "@t3tools/contracts";

import { embeddedPreviewBridge } from "./embeddedPreviewBridge";

/**
 * Module-level handle to the desktop preview bridge.
 *
 * The native T3 desktop client exposes `window.desktopBridge.preview` from
 * its preload. Rearvy embeds the T3 web client in an iframe, where that
 * preload is intentionally not visible, so an Electron-hosted iframe uses
 * the renderer-owned adapter instead.
 */
function isRearvyEmbeddedRuntime(): boolean {
  if (typeof window === "undefined" || window.parent === window) return false;

  const embeddedMarker = new URLSearchParams(window.location.search).get("rearvyEmbedded");
  const electronUserAgent =
    typeof navigator !== "undefined" && /\bElectron\//i.test(navigator.userAgent);
  return embeddedMarker === "1" || electronUserAgent;
}

const nativePreviewBridge =
  typeof window === "undefined" ? null : (window.desktopBridge?.preview ?? null);
const embedded = nativePreviewBridge === null && isRearvyEmbeddedRuntime();

export const previewBridge: DesktopPreviewBridge | null =
  nativePreviewBridge ?? (embedded ? embeddedPreviewBridge() : null);

export const previewBridgeMode: "native" | "embedded" | null = nativePreviewBridge
  ? "native"
  : embedded
    ? "embedded"
    : null;

export const isEmbeddedPreviewBridge = previewBridgeMode === "embedded";
