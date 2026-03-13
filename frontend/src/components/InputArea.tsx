import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadFavorites, modelKey } from "../lib/storage";
import { abortSession, pickModel, sendPrompt, toggleFavorite, useStore } from "../lib/store";

export function InputArea() {
  const { currentSessionId, generating, selectedModel } = useStore();
  const [text, setText] = useState("");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const busy = currentSessionId ? !!generating[currentSessionId] : false;

  // Focus textarea when session changes
  useEffect(() => {
    if (currentSessionId) {
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [currentSessionId]);

  // Auto-resize textarea -- intentionally re-runs when text changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: need to re-run on text changes
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const handleSend = useCallback(() => {
    if (!text.trim() || !currentSessionId) return;
    sendPrompt(text.trim());
    setText("");
  }, [text, currentSessionId]);

  if (!currentSessionId) return null;

  return (
    <div className="input-area">
      <div className="input-controls">
        <div className="picker-bar-item">
          <button className="picker-btn" onClick={() => setModelPickerOpen(!modelPickerOpen)}>
            {selectedModel ? selectedModel.name : "Model..."}
          </button>
          {modelPickerOpen && <ModelPicker onClose={() => setModelPickerOpen(false)} />}
        </div>
      </div>
      <div className="prompt-row">
        <textarea ref={textareaRef} value={text} onChange={(e) => setText(e.target.value)} rows={1} />
        {busy ? (
          <button className="btn send-btn stop" onClick={abortSession}>
            &#9632; Stop
          </button>
        ) : (
          <button className="btn send-btn" onClick={handleSend} disabled={!text.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model picker
// ---------------------------------------------------------------------------

function ModelPicker({ onClose }: { onClose: () => void }) {
  const { selectedModel, providers } = useStore();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => searchRef.current?.focus(), 50);
  }, []);

  // Close when clicking outside
  useEffect(() => {
    function handler(e: MouseEvent) {
      const panel = document.querySelector(".model-picker-dropdown");
      if (panel && !panel.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, [onClose]);

  const favs = loadFavorites();
  const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);

  const allModels: { providerID: string; providerName: string; modelID: string; name: string; key: string }[] = [];
  for (const p of providers) {
    for (const m of p.models) {
      const searchable = `${p.id}/${m.id}`.toLowerCase();
      if (queryWords.length > 0 && !queryWords.every((w) => searchable.includes(w))) continue;
      allModels.push({
        providerID: p.id,
        providerName: p.name,
        modelID: m.id,
        name: m.name,
        key: modelKey(p.id, m.id),
      });
    }
  }

  const favoriteModels = allModels.filter((x) => favs.includes(x.key));

  // Group by provider
  const grouped = new Map<string, typeof allModels>();
  for (const m of allModels) {
    if (!grouped.has(m.providerID)) grouped.set(m.providerID, []);
    grouped.get(m.providerID)?.push(m);
  }

  function pick(m: (typeof allModels)[number]) {
    pickModel(m.providerID, m.modelID, m.name);
    onClose();
  }

  function toggleFav(m: (typeof allModels)[number], e: React.MouseEvent) {
    e.stopPropagation();
    toggleFavorite(m.providerID, m.modelID);
  }

  function renderItem(m: (typeof allModels)[number]) {
    const active = selectedModel?.providerID === m.providerID && selectedModel?.modelID === m.modelID;
    const isFav = favs.includes(m.key);
    return (
      <div key={m.key} className={`picker-item ${active ? "active" : ""}`} onClick={() => pick(m)}>
        <button className={`model-star ${isFav ? "starred" : ""}`} onClick={(e) => toggleFav(m, e)}>
          &#9733;
        </button>
        <span className="picker-item-name">{m.name}</span>
      </div>
    );
  }

  return (
    <div className="model-picker-dropdown">
      <div className="picker-search-wrap">
        <Search className="picker-search-icon" />
        <input ref={searchRef} className="picker-search" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="picker-list">
        {favoriteModels.length > 0 && (
          <>
            <div className="picker-group-header">Favorites</div>
            {favoriteModels.map(renderItem)}
          </>
        )}
        {[...grouped.entries()].map(([providerID, models]) => {
          const providerName = models[0]?.providerName ?? providerID;
          return (
            <div key={providerID}>
              <div className="picker-group-header">{providerName}</div>
              {models.map(renderItem)}
            </div>
          );
        })}
        {allModels.length === 0 && <div className="picker-empty">No models match</div>}
      </div>
    </div>
  );
}
