import { useEffect, useRef } from "react";
import { ChatView } from "./components/ChatView";
import { InputArea } from "./components/InputArea";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { initApp, setSidebarOpen, useStore } from "./lib/store";

export function App() {
  const { sidebarOpen, currentSessionId, currentRepo } = useStore();
  const initialized = useRef(false);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      initApp();
    }
  }, []);

  return (
    <div className="app-root">
      <TopBar />
      <div className="app-body">
        {sidebarOpen && <div className="overlay" onClick={() => setSidebarOpen(false)} />}
        <Sidebar />
        <div className="main">
          <ChatView />
          {(currentSessionId || currentRepo) && <InputArea />}
        </div>
      </div>
    </div>
  );
}
