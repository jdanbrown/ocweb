// Types matching the opencode + sidecar APIs

export interface Repo {
  name: string; // "owner/repo"
  path: string; // "/vol/projects/repos/owner__repo"
}

export interface GithubRepo {
  full_name: string;
  description?: string;
  private: boolean;
}

export interface Worktree {
  repo: string;
  session_id: string;
  path: string;
}

export interface Session {
  id: string;
  title?: string;
  directory?: string;
  parentID?: string;
  time_updated?: number;
  timeUpdated?: number;
}

export interface MessageInfo {
  id: string;
  role: "user" | "assistant" | "error";
  sessionID: string;
  modelID?: string;
  error?: {
    name?: string;
    message?: string;
    data?: { message?: string };
  };
}

export interface MessagePart {
  id: string;
  type: "text" | "reasoning" | "tool" | "step-start" | "step-finish" | "snapshot" | "patch" | "subtask" | "compaction";
  sessionID?: string;
  messageID?: string;
  text?: string;
  tool?: string;
  callID?: string; // opencode tool call id (only on tool parts; matches PendingQuestion.callID)
  state?: ToolState;
  tokens?: {
    input?: number;
    output?: number;
    cache?: { read?: number };
  };
}

// Matches opencode's Question.Info (see packages/opencode/src/question/index.ts)
export interface QuestionInfo {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiple?: boolean;
  custom?: boolean;
}

// One outstanding `question.asked` request, awaiting user reply.
// Keyed by callID in the store; needs requestID to POST the reply.
export interface PendingQuestion {
  requestID: string;
  sessionID: string;
  callID: string;
  questions: QuestionInfo[];
}

export interface ToolState {
  status: "pending" | "running" | "completed" | "error";
  title?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  // Tool-specific metadata (e.g. task tool: { sessionId, model } for the spawned subagent)
  metadata?: Record<string, unknown>;
}

// One entry in the subagent view stack -- what session we're viewing and how to reach it.
// Kept in-memory only (not persisted), because subagent sessions are tied to a parent worktree.
export interface SubagentView {
  sessionId: string;
  directory: string;
  title: string;
}

export interface Message {
  info: MessageInfo;
  parts: MessagePart[];
}

// SSE event shape from opencode
export interface SSEEvent {
  type: string;
  properties: Record<string, unknown>;
}

export interface Provider {
  id: string;
  name?: string;
  models?: Record<string, Model>;
}

export interface Model {
  id: string;
  name?: string;
}

export interface SelectedModel {
  providerID: string;
  modelID: string;
  name: string;
}
