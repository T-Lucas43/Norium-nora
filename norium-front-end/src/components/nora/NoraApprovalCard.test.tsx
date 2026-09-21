import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "../../core/api/client";
import NoraApprovalCard, { normalizeApprovalCard } from "./NoraApprovalCard";

vi.mock("../../core/api/client");

const DIGEST = "ab".repeat(32);

function approvalItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval_email_1",
    action: "nora_email_send_exact",
    source: "email",
    title: "Enviar e-mail para chefe@empresa.com",
    status: "pending",
    digest: DIGEST,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    metadata: { workspace: "primary", tool: "gmail", version: "nora-email-v1" },
    description: "Para: chefe@empresa.com\nAssunto: Proposta\nSegue a proposta combinada.",
    payload: {
      kind: "nora_email_exact",
      idempotencyKey: "email_abc123",
      emailExact: {
        to: ["chefe@empresa.com"],
        cc: ["copia@empresa.com"],
        bcc: [],
        subject: "Proposta",
        body: "Segue a proposta combinada.",
        attachments: [],
      },
    },
    ...overrides,
  };
}

describe("normalizeApprovalCard", () => {
  it("rejects garbage and extracts the email snapshot", () => {
    expect(normalizeApprovalCard(null)).toBeNull();
    expect(normalizeApprovalCard({})).toBeNull();
    expect(normalizeApprovalCard({ id: "" })).toBeNull();
    const snapshot = normalizeApprovalCard(approvalItem());
    expect(snapshot?.id).toBe("approval_email_1");
    expect(snapshot?.recipients).toEqual(["chefe@empresa.com", "copia@empresa.com"]);
    expect(snapshot?.workspace).toBe("primary");
    expect(snapshot?.version).toBe("nora-email-v1");
    expect(snapshot?.digest).toBe(DIGEST);
    expect(snapshot?.uncertain).toBe(false);
  });
});

describe("NoraApprovalCard", () => {
  beforeEach(() => {
    vi.mocked(apiRequest).mockReset();
  });

  it("renders action, recipients, workspace, version, digest and expiry", () => {
    const snapshot = normalizeApprovalCard(approvalItem())!;
    render(<NoraApprovalCard approval={snapshot} onDecision={vi.fn()} />);

    expect(screen.getByRole("article", { name: "Aprovação: Enviar e-mail para chefe@empresa.com" })).toBeInTheDocument();
    expect(screen.getByText("chefe@empresa.com, copia@empresa.com")).toBeInTheDocument();
    expect(screen.getByText("primary")).toBeInTheDocument();
    expect(screen.getByText("nora-email-v1")).toBeInTheDocument();
    expect(screen.getByText(`${DIGEST.slice(0, 12)}…`)).toBeInTheDocument();
    expect(screen.getByText("Aguardando decisão")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Permitir esta ação" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Negar" })).toBeInTheDocument();
  });

  it("approves with the exact digest once even on double click", async () => {
    const snapshot = normalizeApprovalCard(approvalItem())!;
    const onDecision = vi.fn();
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => { release = resolve; });
    vi.mocked(apiRequest).mockImplementationOnce(() => gate as Promise<{ item: unknown }>);
    const user = userEvent.setup();
    render(<NoraApprovalCard approval={snapshot} onDecision={onDecision} />);

    const allow = screen.getByRole("button", { name: "Permitir esta ação" });
    await user.click(allow);
    await user.click(allow);
    expect(vi.mocked(apiRequest)).toHaveBeenCalledTimes(1);
    release({ item: approvalItem({ status: "executed", decidedAt: new Date().toISOString(), execution: { response: "E-mail enviado." } }) });
    await waitFor(() => expect(onDecision).toHaveBeenCalledTimes(1));

    expect(vi.mocked(apiRequest)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiRequest)).toHaveBeenCalledWith("/api/operacao/aprovacoes/approval_email_1", {
      method: "PATCH",
      body: JSON.stringify({ decision: "approved", expectedDigest: DIGEST }),
    });
    expect(onDecision.mock.calls[0][0].status).toBe("executed");
    expect(onDecision.mock.calls[0][0].outcome).toBe("E-mail enviado.");
    expect(await screen.findByText("Ação permitida.")).toBeInTheDocument();
  });

  it("denies without executing anything", async () => {
    const snapshot = normalizeApprovalCard(approvalItem())!;
    const onDecision = vi.fn();
    vi.mocked(apiRequest).mockImplementation(async () => ({
      item: approvalItem({ status: "rejected", decidedAt: new Date().toISOString(), decisionNote: "Negado no chat." }),
    }));
    const user = userEvent.setup();
    render(<NoraApprovalCard approval={snapshot} onDecision={onDecision} />);

    await user.click(screen.getByRole("button", { name: "Negar" }));
    await waitFor(() => expect(onDecision).toHaveBeenCalledTimes(1));

    expect(vi.mocked(apiRequest)).toHaveBeenCalledWith("/api/operacao/aprovacoes/approval_email_1", {
      method: "PATCH",
      body: JSON.stringify({ decision: "rejected", expectedDigest: DIGEST }),
    });
    expect(onDecision.mock.calls[0][0].status).toBe("rejected");
  });

  it("shows digest mismatch errors and keeps the card pending", async () => {
    const snapshot = normalizeApprovalCard(approvalItem())!;
    const onDecision = vi.fn();
    vi.mocked(apiRequest).mockRejectedValue(new Error("O conteúdo mudou após a preparação."));
    const user = userEvent.setup();
    render(<NoraApprovalCard approval={snapshot} onDecision={onDecision} />);

    await user.click(screen.getByRole("button", { name: "Permitir esta ação" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("O conteúdo mudou após a preparação.");
    expect(onDecision).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Permitir esta ação" })).toBeInTheDocument();
  });

  it("reconciles uncertain sends without resending", async () => {
    const snapshot = normalizeApprovalCard(
      approvalItem({ status: "failed", executionUncertain: true, execution: { response: "Resultado incerto." } }),
    )!;
    const onDecision = vi.fn();
    vi.mocked(apiRequest).mockImplementation(async () => ({
      reconciled: true,
      item: approvalItem({ status: "executed", executionUncertain: false, execution: { response: "E-mail confirmado." } }),
    }));
    const user = userEvent.setup();
    render(<NoraApprovalCard approval={snapshot} onDecision={onDecision} />);

    expect(screen.getByText("Resultado incerto")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Verificar envio" }));
    await waitFor(() => expect(onDecision).toHaveBeenCalledTimes(1));

    expect(vi.mocked(apiRequest)).toHaveBeenCalledWith("/api/operacao/aprovacoes/approval_email_1/reconciliar", { method: "POST" });
    expect(onDecision.mock.calls[0][0].status).toBe("executed");
  });

  it("renders decided cards without action buttons", () => {
    const snapshot = normalizeApprovalCard(approvalItem({ status: "rejected", outcome: undefined, decisionNote: "Negado." }))!;
    render(<NoraApprovalCard approval={snapshot} onDecision={vi.fn()} />);

    expect(screen.getByText("Negada")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Permitir esta ação" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Negar" })).not.toBeInTheDocument();
    expect(screen.getByText("Negado.")).toBeInTheDocument();
  });
});
