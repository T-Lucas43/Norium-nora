import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../../core/api/client";
import NoraBrainJobs from "./NoraBrainJobs";

vi.mock("../../core/api/client", async (load) => ({
  ...await load<typeof import("../../core/api/client")>(),
  apiRequest: vi.fn(),
}));

const pending = {
  id: "job-1234567890123456",
  message: "Envie o aviso",
  profile: "routine",
  status: "awaiting_approval",
  result: "Revise a operação exata antes de aprovar.",
  updatedAt: 1_800_000_000,
  budget: { tokens: 100, calls: 1, tools: 0, seconds: 2 },
  steps: [{
    id: "step-12345678",
    tool: "email_send",
    status: "awaiting_approval",
    prepared: { digest: "a".repeat(64), policy: "R", prepared: {
      sender: "conta@example.test", to: ["cliente@example.test"], cc: [], bcc: [],
      subject: "Aviso", body: "Conteúdo exato", attachments: [{ name: "proposta.pdf", sha256: "b".repeat(64) }],
    } },
    approval: { id: "approval-12345678", digest: "a".repeat(64), expiresAt: 1_800_086_400 },
  }],
} as const;

describe("NoraBrainJobs", () => {
  beforeEach(() => {
    vi.mocked(apiRequest).mockImplementation(async (path) => {
      if (path === "/api/nora/brain/jobs") return { items: [pending] };
      return { job: { ...pending, status: "queued" } };
    });
  });

  it("shows the exact operation and only approves after the user clicks", async () => {
    const user = userEvent.setup();
    render(<NoraBrainJobs onClose={vi.fn()} />);
    expect(await screen.findByText("conta@example.test")).toBeInTheDocument();
    expect(screen.getByText("cliente@example.test")).toBeInTheDocument();
    expect(screen.getByText("Conteúdo exato")).toBeInTheDocument();
    expect(vi.mocked(apiRequest).mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Aprovar esta versão" }));

    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(
      `/api/nora/brain/jobs/${pending.id}/approval`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ approvalId: pending.steps[0].approval.id, digest: pending.steps[0].approval.digest }),
      }),
    ));
  });

  it("binds the HTTP idempotency key to the persisted request id", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path, options) => {
      if (path === "/api/nora/brain/jobs" && !options?.method) return { items: [] };
      return { job: pending };
    });
    const user = userEvent.setup();
    render(<NoraBrainJobs onClose={vi.fn()} />);
    await user.type(await screen.findByPlaceholderText("Descreva o resultado que você precisa..."), "Crie uma tarefa");
    await user.click(screen.getByRole("button", { name: "Iniciar" }));

    await waitFor(() => {
      const call = vi.mocked(apiRequest).mock.calls.find(([, options]) => options?.method === "POST");
      expect(call).toBeDefined();
      const body = JSON.parse(String(call?.[1]?.body));
      const headers = call?.[1]?.headers as Record<string, string>;
      expect(headers["Idempotency-Key"]).toBe(body.requestId);
      expect(body.message).toBe("Crie uma tarefa");
    });
  });

  it("records an explicit rejection of the exact reviewed operation", async () => {
    const user = userEvent.setup();
    render(<NoraBrainJobs onClose={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Não aprovar" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(
      `/api/nora/brain/jobs/${pending.id}/approval/reject`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ approvalId: pending.steps[0].approval.id, digest: pending.steps[0].approval.digest }),
      }),
    ));
  });

  it("shows the real execution trace and evidence coverage", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ items: [{
      ...pending,
      status: "completed",
      steps: [{
        ...pending.steps[0],
        status: "succeeded",
        result: { evidence: { messageId: "message-1", sender: "conta@example.test" } },
      }],
    }] });

    render(<NoraBrainJobs onClose={vi.fn()} />);

    expect(await screen.findByText("1/1 com evidência")).toBeInTheDocument();
    expect(screen.getByText("Plano e trilha de execução")).toBeInTheDocument();
    expect(screen.getByText(/Evidências: messageId, sender/)).toBeInTheDocument();
  });
});
