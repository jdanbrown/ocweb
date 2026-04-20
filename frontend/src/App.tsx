import { useCallback, useEffect, useRef } from "react";
import { ChatView } from "./components/ChatView";
import { DebugLogPanel } from "./components/DebugLogPanel";
import { InputArea } from "./components/InputArea";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { closeSubagent, initApp, setDebugLogOpen, setSidebarOpen, useStore } from "./lib/store";

// Thresholds for swipe gestures
// - EDGE_ZONE_PX: only left-edge-starting touches trigger open-sidebar (avoid hijacking text-selection drags elsewhere)
// - SWIPE_MIN_DX: minimum horizontal distance to count as a swipe
const EDGE_ZONE_PX = 24;
const SWIPE_MIN_DX = 60;

export function App() {
  const { sidebarOpen, currentSessionId, currentRepo, viewStack, debugLogOpen } = useStore();
  const initialized = useRef(false);
  const inSubagentView = viewStack.length > 0;

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      initApp();
    }
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
        {debugLogOpen && <DebugLogPanel onClose={() => setDebugLogOpen(false)} />}
      </div>
    </div>
  );
}
