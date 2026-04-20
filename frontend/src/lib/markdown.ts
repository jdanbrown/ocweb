// Markdown rendering for assistant text.
//
// We use `marked` in its default (GFM-enabled) mode. The LLM output is trusted
// for a personal-use app (single user, their own agents), so we skip DOMPurify
// to keep the frontend small. If that changes, swap in DOMPurify here.
//
// `marked.parse` is synchronous in recent versions; we cast the return type.

import { marked } from "marked";

marked.setOptions({
  gfm: true,
  breaks: true, // single newlines become <br> -- matches how chat users write
});

export function renderMarkdown(text: string): string {
  return marked.parse(text) as string;
}
