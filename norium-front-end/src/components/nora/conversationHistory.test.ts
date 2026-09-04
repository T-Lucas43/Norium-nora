import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationWriter, draftConversation } from "./conversationHistory";
import { apiRequest } from "../../core/api/client";
vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));

describe("Nora conversation persistence", () => {
  beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); });
  it("serializes a newer snapshot behind a slow save and carries the returned revision", async () => {
    let finish!: (value: unknown) => void;
    const record = draftConversation();
    vi.mocked(apiRequest).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce({ ...record, revision: 2 });
    const writer = new ConversationWriter(record, vi.fn());
    writer.stage({ messages: [{ role: "user", text: "Planejar a semana" }] });
    const pending = writer.flush();
    writer.stage({ messages: [{ role: "user", text: "Planejar a semana" }, { role: "ai", text: "Aqui está o plano." }] });
    expect(apiRequest).toHaveBeenCalledTimes(1);
    finish({ ...record, revision: 1 });
    await pending;
    const body = JSON.parse(String(vi.mocked(apiRequest).mock.calls[1][1]?.body));
    expect(body.revision).toBe(1);
    expect(body.state.messages).toHaveLength(2);
    expect(writer.dirty).toBe(false);
  });
  it("retains a failed snapshot for retry and keeps the original workspace", async () => {
    localStorage.setItem("norium-workspace-id", "workspace-a");
    const record = draftConversation();
    const writer = new ConversationWriter(record, vi.fn());
    writer.stage({ messages: [{ role: "user", text: "Primeira pergunta" }] });
    localStorage.setItem("norium-workspace-id", "workspace-b");
    vi.mocked(apiRequest).mockRejectedValueOnce(new Error("Sem conexão")).mockResolvedValueOnce({ ...record, revision: 1 });
    await expect(writer.flush()).rejects.toThrow("Sem conexão");
    expect(writer.dirty).toBe(true);
    await writer.flush();
    expect(writer.dirty).toBe(false);
    expect(vi.mocked(apiRequest).mock.calls[1][1]?.headers).toEqual({ "X-Norium-Workspace": "workspace-a" });
  });
});
