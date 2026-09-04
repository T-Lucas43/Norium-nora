import { apiRequest } from "../../core/api/client";
import type { NoraConversationState } from "../layout/Nora";

export type ConversationSummary = { id: string; title: string; preview: string; messageCount: number; createdAt: string; updatedAt: string; revision: number };
export type SavedConversation = ConversationSummary & { state: NoraConversationState };
export const emptyConversationState = (): NoraConversationState => ({ messages: [] });
export function draftConversation(): SavedConversation {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), title: "Nova conversa", preview: "", messageCount: 0, createdAt: now, updatedAt: now, revision: 0, state: emptyConversationState() };
}

/** Serializes snapshots so a slow save cannot overwrite a newer response. */
export class ConversationWriter {
  private pending: NoraConversationState | null = null;
  private running: Promise<void> | null = null;
  private lastSaved: string;
  private token: string | null;
  private workspace: string;
  public conversation: SavedConversation;
  private onSaved: (summary: ConversationSummary) => void;
  constructor(conversation: SavedConversation, onSaved: (summary: ConversationSummary) => void) {
    this.conversation = conversation;
    this.onSaved = onSaved;
    this.lastSaved = JSON.stringify(conversation.state);
    this.token = localStorage.getItem("norium-auth-token") || sessionStorage.getItem("norium-auth-token");
    this.workspace = localStorage.getItem("norium-workspace-id") || "primary";
  }
  stage(state: NoraConversationState) {
    if (JSON.stringify(state) === this.lastSaved && !this.running) return;
    this.pending = state;
    this.conversation.state = state;
    if (this.conversation.revision === 0 && this.conversation.title === "Nova conversa") {
      this.conversation.title = state.messages.find((message) => message.role === "user")?.text.trim().slice(0, 80) || "Nova conversa";
    }
  }
  get dirty() { return Boolean(this.pending || this.running); }
  async flush(): Promise<void> {
    if (this.running) { await this.running; if (this.pending) await this.flush(); return; }
    if (!this.pending) return;
    this.running = this.drain();
    try { await this.running; } finally { this.running = null; }
  }
  private async drain() {
    while (this.pending) {
      const state = this.pending;
      this.pending = null;
      try {
        const summary = await apiRequest<ConversationSummary>(`/api/nora/conversations/${this.conversation.id}`, {
          method: "PUT", token: this.token, headers: { "X-Norium-Workspace": this.workspace },
          body: JSON.stringify({ title: this.conversation.title, revision: this.conversation.revision, state }),
        });
        Object.assign(this.conversation, summary);
        this.lastSaved = JSON.stringify(state);
        this.onSaved(summary);
      } catch (error) {
        this.pending ??= state;
        throw error;
      }
    }
  }
  async rename(title: string) {
    await this.flush();
    this.conversation.title = title;
    this.pending = this.conversation.state;
    await this.flush();
  }
}
