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
  it("preserves the entire exact email body instead of the short description", () => {
    const body = `${"Mensagem completa. ".repeat(100)}Fim do conteúdo exato.`;
    const raw = approvalItem();
    raw.description = "Prévia curta que não contém o final.";
    raw.payload.emailExact.body = body;
    const snapshot = normalizeApprovalCard(raw)!;
    expect(snapshot.summary).toContain(body);
    expect(snapshot.summary).toContain("Cc: copia@empresa.com");
    expect(snapshot.summary).not.toContain(raw.description);
    render(<NoraApprovalCard approval={snapshot} onDecision={vi.fn()} />);
    expect(screen.getByLabelText("Detalhes da ação")).toHaveTextContent("Fim do conteúdo exato.");
    expect(screen.getByRole("button", { name: "Permitir esta ação" })).toBeEnabled();
  });

  it("shows blind-copy targets and attachment names before approval", () => {
    const raw = approvalItem();
    const payload = { ...raw.payload, emailExact: { ...raw.payload.emailExact, bcc: ["oculto@example.test"], attachments: [{ fileName: "proposta.pdf" }] } };
    const snapshot = normalizeApprovalCard({ ...raw, payload })!;
    expect(snapshot.summary).toContain("Cco: oculto@example.test");
    expect(snapshot.summary).not.toContain("Anexos:");
    expect(snapshot.attachments).toEqual([{ fileName: "proposta.pdf", size: 0 }]);
    render(<NoraApprovalCard approval={snapshot} onDecision={vi.fn()} />);
    expect(screen.getByText("proposta.pdf")).toBeInTheDocument();
  });

  it("keeps the email draft session and exact attachment metadata for the preview", () => {
    const base = approvalItem();
    const raw = approvalItem({
      payload: {
        ...base.payload,
        sessionId: "email-session-123",
        emailExact: {
          ...base.payload.emailExact,
          attachments: [{ fileName: "proposta.pdf", mimeType: "application/pdf", size: 2048 }],
        },
      },
    });

    expect(normalizeApprovalCard(raw)).toMatchObject({
      emailSessionId: "email-session-123",
      attachments: [{ fileName: "proposta.pdf", mimeType: "application/pdf", size: 2048 }],
    });
  });

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

  it("uploads selected files through the preview callback for its bound email session", async () => {
    const base = approvalItem();
    const approval = normalizeApprovalCard(approvalItem({
      payload: { ...base.payload, sessionId: "email-session-123" },
    }))!;
    const onAttachFiles = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    const file = new File(["proposal"], "proposta.pdf", { type: "application/pdf" });
    render(<NoraApprovalCard approval={approval} onDecision={vi.fn()} onAttachFiles={onAttachFiles} />);

    await user.upload(screen.getByLabelText("Arquivos para anexar ao e-mail"), file);

    await waitFor(() => expect(onAttachFiles).toHaveBeenCalledWith("email-session-123", [file]));
    expect(screen.getByRole("button", { name: "Permitir esta ação" })).toBeInTheDocument();
  });

  it("refuses a ninth email attachment before calling the upload handler", async () => {
    const base = approvalItem();
    const approval = normalizeApprovalCard(approvalItem({
      payload: {
        ...base.payload,
        sessionId: "email-session-123",
        emailExact: {
          ...base.payload.emailExact,
          attachments: Array.from({ length: 8 }, (_, index) => ({ fileName: `arquivo-${index + 1}.pdf`, size: 1 })),
        },
      },
    }))!;
    const onAttachFiles = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<NoraApprovalCard approval={approval} onDecision={vi.fn()} onAttachFiles={onAttachFiles} />);

    await user.upload(screen.getByLabelText("Arquivos para anexar ao e-mail"), new File(["x"], "extra.pdf"));

    expect(await screen.findByRole("alert")).toHaveTextContent("até 8 arquivos");
    expect(onAttachFiles).not.toHaveBeenCalled();
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
