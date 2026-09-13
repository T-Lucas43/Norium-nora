import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ apiRequest: vi.fn(), apiBlobRequest: vi.fn() }));
vi.mock("../../core/api/client", () => api);
vi.mock("../commercial/PdfDocumentPreview", () => ({ default: ({ title }: { title: string }) => <div>Prévia: {title}</div> }));
import BrowserResearchForm from "./BrowserResearchForm";
import BrowserReportEditor from "./BrowserReportEditor";

const report = { title: "Resumo inicial", content: "## Síntese\nFato verificado [1].", revision: 1, sources: [{ title: "Fonte consultada", url: "https://example.com/", accessedAt: "2026-09-07" }], warnings: [], coverage: "1 página lida", generator: "nora" };

describe("Browser research workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:report"), revokeObjectURL: vi.fn() }));
    api.apiBlobRequest.mockResolvedValue(new Blob(["%PDF"], { type: "application/pdf" }));
  });
  it("lets the user choose academic research and prepares it without executing", async () => {
    const onPlanned = vi.fn(), user = userEvent.setup();
    api.apiRequest.mockResolvedValue({ item: { id: "research-1" } });
    render(<BrowserResearchForm profiles={[]} onPlanned={onPlanned} />);
    await user.click(screen.getByRole("button", { name: "Acadêmico" }));
    await user.type(screen.getByLabelText("Endereço do site"), "https://example.com/");
    await user.click(screen.getByRole("button", { name: "Preparar pesquisa" }));
    await waitFor(() => expect(onPlanned).toHaveBeenCalledWith("research-1"));
    expect(api.apiRequest).toHaveBeenCalledTimes(1);
    const [path, options] = api.apiRequest.mock.calls[0];
    expect(path).toBe("/api/navegador/runs/plan");
    expect(JSON.parse(options.body)).toMatchObject({ taskType: "academic", scope: "site", maxPages: 10 });
  });
  it("revises the existing plan before execution", async () => {
    api.apiRequest.mockResolvedValue({ item: { id: "existing" } });
    const user = userEvent.setup();
    render(<BrowserResearchForm profiles={[]} initial={{ id: "existing", objective: "Analise o site", startUrl: "https://example.com/", taskType: "layout" }} onPlanned={vi.fn()} />);
    await user.selectOptions(screen.getByLabelText("Escopo"), "page");
    await user.click(screen.getByRole("button", { name: "Salvar pedido" }));
    expect(api.apiRequest).toHaveBeenCalledWith("/api/navegador/runs/existing/research-plan", expect.objectContaining({ method: "PUT" }));
  });
  it("saves edited report text, refreshes PDF preview and keeps server-owned sources", async () => {
    api.apiRequest.mockImplementation(async (_path: string, options?: { method: string; body: string }) => ({ item: options?.method === "PUT" ? { ...report, ...JSON.parse(options.body), revision: 2 } : report }));
    const user = userEvent.setup();
    render(<BrowserReportEditor runId="existing" />);
    await user.click(await screen.findByRole("button", { name: "Editar relatório" }));
    await user.clear(screen.getByLabelText("Texto do relatório"));
    await user.type(screen.getByLabelText("Texto do relatório"), "Conteúdo revisado.");
    expect(screen.getByRole("button", { name: "Baixar PDF" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Salvar e atualizar PDF" }));
    await waitFor(() => expect(screen.getByText(/Versão 2/)).toBeInTheDocument());
    expect(api.apiBlobRequest).toHaveBeenCalledTimes(2);
    const mutation = api.apiRequest.mock.calls.find(call => call[1]?.method === "PUT");
    expect(JSON.parse(mutation?.[1].body)).toEqual({ title: "Resumo inicial", content: "Conteúdo revisado.", revision: 1 });
  });
  it("retains the draft when another editor has updated the report", async () => {
    api.apiRequest.mockImplementation(async (_path: string, options?: { method: string }) => { if (options?.method === "PUT") throw new Error("O relatório foi atualizado em outra janela."); return { item: report }; });
    const user = userEvent.setup();
    render(<BrowserReportEditor runId="existing" />);
    await user.click(await screen.findByRole("button", { name: "Editar relatório" }));
    await user.type(screen.getByLabelText("Título"), " revisado");
    await user.click(screen.getByRole("button", { name: "Salvar e atualizar PDF" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("outra janela");
    expect(screen.getByLabelText("Título")).toHaveValue("Resumo inicial revisado");
  });
  it("rewrites an existing analysis and refreshes its PDF", async () => {
    api.apiRequest.mockImplementation(async (path: string) => ({ item: path.endsWith("/rewrite") ? { ...report, content: "Uma explicação com contexto e relações entre os conceitos [1].", revision: 2 } : report }));
    const user = userEvent.setup();
    render(<BrowserReportEditor runId="existing" />);
    await user.click(await screen.findByRole("button", { name: "Reescrever com Nora" }));
    await user.clear(screen.getByLabelText("Como a Nora deve melhorar o relatório?"));
    await user.type(screen.getByLabelText("Como a Nora deve melhorar o relatório?"), "Explique os conceitos com exemplos.");
    await user.click(screen.getByRole("button", { name: "Gerar nova redação" }));
    await waitFor(() => expect(screen.getByText(/Versão 2/)).toBeInTheDocument());
    expect(api.apiRequest).toHaveBeenCalledWith("/api/navegador/runs/existing/report/rewrite", expect.objectContaining({ method: "POST", body: JSON.stringify({ instruction: "Explique os conceitos com exemplos.", revision: 1 }) }));
    expect(api.apiBlobRequest).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Editar relatório" }));
    expect(screen.getByLabelText("Texto do relatório")).toHaveValue("Uma explicação com contexto e relações entre os conceitos [1].");
  });
  it("keeps the previous analysis when Nora cannot rewrite it", async () => {
    api.apiRequest.mockImplementation(async (path: string) => { if (path.endsWith("/rewrite")) throw new Error("Nora indisponível. Tente novamente."); return { item: report }; });
    const user = userEvent.setup();
    render(<BrowserReportEditor runId="existing" />);
    await user.click(await screen.findByRole("button", { name: "Reescrever com Nora" }));
    await user.click(screen.getByRole("button", { name: "Gerar nova redação" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nora indisponível");
    expect(screen.getByText(/Versão 1/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Editar relatório" }));
    expect(screen.getByLabelText("Texto do relatório")).toHaveValue(report.content);
  });
  it("retries a failed PDF download without losing the report", async () => {
    api.apiRequest.mockResolvedValue({ item: report });
    api.apiBlobRequest.mockRejectedValueOnce(new Error("Falha ao carregar o PDF."));
    const user = userEvent.setup();
    render(<BrowserReportEditor runId="existing" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Falha ao carregar");
    await user.click(screen.getByRole("button", { name: "Tentar carregar PDF" }));
    expect(await screen.findByText("Prévia: Resumo inicial")).toBeInTheDocument();
    expect(api.apiBlobRequest).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Baixar PDF" })).toBeEnabled();
  });
});
