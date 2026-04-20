import { useCallback, useEffect, useRef } from "react";
import { ChatView } from "./components/ChatView";
import { InputArea } from "./components/InputArea";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { closeSubagent, debugLog, initApp, setSidebarOpen, useStore } from "./lib/store";

// Thresholds for swipe gestures
// - EDGE_ZONE_PX: only left-edge-starting touches trigger open-sidebar (avoid hijacking text-selection drags elsewhere)
// - SWIPE_MIN_DX: minimum horizontal distance to count as a swipe
const EDGE_ZONE_PX = 24;
const SWIPE_MIN_DX = 60;

// Temporary -- used by the status-bar-tap debug logger below. Remove with the logger.
function describe(t: EventTarget | null): string {
  if (!t || !(t instanceof Element)) return String(t);
  const tag = t.tagName.toLowerCase();
  const cls = t.className && typeof t.className === "string" ? `.${t.className.split(" ").join(".")}` : "";
  return `${tag}${cls}`.slice(0, 60);
}

export function App() {
  const { sidebarOpen, currentSessionId, currentRepo, viewStack } = useStore();
  const initialized = useRef(false);
  const inSubagentView = viewStack.length > 0;

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      initApp();
    }
  }, []);

  // --- Temporary debug instrumentation for status-bar-tap / scroll-to-top ---
  // Logs a variety of window- and document-level events into the chat so we can
  // see empirically what iOS dispatches when the user taps the status bar.
  // Remove (and the `debugLog` helper) when the scroll-to-top task is done.
  useEffect(() => {
    const standalone =
      // @ts-expect-error -- iOS-only property, not in standard lib.dom
      typeof navigator !== "undefined" && navigator.standalone === true;
    const safeTop = getComputedStyle(document.documentElement).getPropertyValue("--safe-area-inset-top");
    const vv = window.visualViewport;
    debugLog(
      `boot ua=${navigator.userAgent.slice(0, 80)} standalone=${standalone} innerH=${window.innerHeight} ` +
        `vv=${vv ? `${vv.height}@${vv.offsetTop}` : "none"} safeTop=${safeTop || "none"}`,
    );

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      if (t.clientY <= 80) {
        debugLog(`touchstart y=${t.clientY.toFixed(0)} x=${t.clientX.toFixed(0)} target=${describe(e.target)}`);
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (!t) return;
      if (t.clientY <= 80) {
        debugLog(`touchend y=${t.clientY.toFixed(0)} x=${t.clientX.toFixed(0)} target=${describe(e.target)}`);
      }
    };
    const onScroll = () => {
      debugLog(`window scroll scrollY=${window.scrollY} docEl=${document.documentElement.scrollTop}`);
    };
    const onBodyScroll = (e: Event) => {
      debugLog(`body scroll target=${describe(e.target)} scrollY=${window.scrollY}`);
    };
    const onClick = (e: MouseEvent) => {
      if (e.clientY <= 80) {
        debugLog(`click y=${e.clientY.toFixed(0)} x=${e.clientX.toFixed(0)} target=${describe(e.target)}`);
      }
    };
    const onVVScroll = () => {
      const v = window.visualViewport;
      if (!v) return;
      debugLog(`visualViewport scroll h=${v.height} offsetTop=${v.offsetTop} pageTop=${v.pageTop}`);
    };
    const onVVResize = () => {
      const v = window.visualViewport;
      if (!v) return;
      debugLog(`visualViewport resize h=${v.height} offsetTop=${v.offsetTop}`);
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true, capture: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    document.body.addEventListener("scroll", onBodyScroll, { passive: true });
    window.addEventListener("click", onClick, { passive: true, capture: true });
    window.visualViewport?.addEventListener("scroll", onVVScroll);
    window.visualViewport?.addEventListener("resize", onVVResize);
    return () => {
      window.removeEventListener("touchstart", onTouchStart, true);
      window.removeEventListener("touchend", onTouchEnd, true);
      window.removeEventListener("scroll", onScroll);
      document.body.removeEventListener("scroll", onBodyScroll);
      window.removeEventListener("click", onClick, true);
      window.visualViewport?.removeEventListener("scroll", onVVScroll);
      window.visualViewport?.removeEventListener("resize", onVVResize);
    };
  }, []);

  // Swipe-from-left-edge to open sidebar (only on app root, not overlay)
  const edgeTouchStart = useRef<{ x: number; y: number } | null>(null);
  const onRootTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    // Only track touches that start in the left edge zone
    if (t.clientX <= EDGE_ZONE_PX) {
      edgeTouchStart.current = { x: t.clientX, y: t.clientY };
    } else {
      edgeTouchStart.current = null;
    }
  }, []);
  const onRootTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const start = edgeTouchStart.current;
      edgeTouchStart.current = null;
      if (!start) return;
      const dx = e.changedTouches[0].clientX - start.x;
      const dy = e.changedTouches[0].clientY - start.y;
      // Horizontal dominance + rightward swipe past threshold
      if (dx < SWIPE_MIN_DX || Math.abs(dy) > Math.abs(dx)) return;
      // When viewing a subagent, edge-swipe acts as "back" instead of opening the sidebar
      if (inSubagentView) closeSubagent();
      else setSidebarOpen(true);
    },
    [inSubagentView],
  );

  // Swipe-left on overlay to close sidebar
  // Safe to trigger anywhere on the overlay -- it blocks main-content interactions (including text select) when sidebar is open
  const overlayTouchStart = useRef<{ x: number; y: number } | null>(null);
  const onOverlayTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    overlayTouchStart.current = { x: t.clientX, y: t.clientY };
  }, []);
  const onOverlayTouchEnd = useCallback((e: React.TouchEvent) => {
    const start = overlayTouchStart.current;
    overlayTouchStart.current = null;
    if (!start) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    // Leftward swipe past threshold (tap-to-close is handled by onClick)
    if (dx > -SWIPE_MIN_DX || Math.abs(dy) > Math.abs(dx)) return;
    setSidebarOpen(false);
  }, []);

  return (
    <div className="app-root" onTouchStart={onRootTouchStart} onTouchEnd={onRootTouchEnd}>
      <TopBar />
      <div className="app-body">
        {sidebarOpen && (
          <div
            className="overlay"
            onClick={() => setSidebarOpen(false)}
            onTouchStart={onOverlayTouchStart}
            onTouchEnd={onOverlayTouchEnd}
          />
        )}
        <Sidebar />
        <div className="main">
          <ChatView />
          {(currentSessionId || currentRepo) && <InputArea />}
        </div>
      </div>
    </div>
  );
}
