import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoraMailJobCard, type MailWork } from "./NoraMailWork";
import { apiRequest } from "../../core/api/client";

vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn(), apiBlobRequest: vi.fn() }));
const pending = (): MailWork => ({ id: "job-1", digest: "a".repeat(64), sender: "owner@example.test", status: "awaiting_approval", read: 0, failed: 0, estimatedTotal: 0, sent: 0, pageCount: 0, unread: 0, attachments: 0, truncatedBodies: 0, unknown: null, recipientCount: 1, updatedAt: "2026-10-08", summaries: [], highlights: [], attempts: [], spec: { kind: "campaign", folder: "inbox", query: "", analyze: false, includeBody: false, messageBudget: 1000, recipients: [{ email: "client@example.test", name: "Cliente" }], subject: "Olá {{nome}}", body: "Mensagem para {{email}}", purpose: "Atualização autorizada" } });

describe("Campaign review", () => {
  beforeEach(() => vi.mocked(apiRequest).mockReset());
  it("requires review acknowledgement and submits the exact digest", async () => {
    const job = pending();
    vi.mocked(apiRequest).mockResolvedValueOnce({ job } as never).mockResolvedValue({ job: { ...job, status: "completed" } } as never);
    render(<NoraMailJobCard jobId={job.id} initialJob={job} />);
    const approve = await screen.findByRole("button", { name: "Aprovar e enviar individualmente" });
    expect(approve).toBeDisabled();
    expect(screen.getByText("Mensagem para client@example.test")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(approve);
    await waitFor(() => expect(vi.mocked(apiRequest)).toHaveBeenCalledWith(expect.stringContaining("/approve"), expect.objectContaining({ method: "POST", body: JSON.stringify({ digest: job.digest, acknowledged: true }) })));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("keeps an uncertain send stopped and offers reconciliation", async () => {
    const job = { ...pending(), status: "unknown", unknown: 0 };
    vi.mocked(apiRequest).mockResolvedValue({ job } as never);
    render(<NoraMailJobCard jobId={job.id} initialJob={job} />);
    expect(await screen.findByRole("button", { name: "Reconciliar envio" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Continuar$/ })).not.toBeInTheDocument();
    expect(vi.mocked(apiRequest).mock.calls.some(([path]) => path.endsWith("/advance"))).toBe(false);
  });
});
