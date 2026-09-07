import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommercialProposal } from "../../features/commercial/types";
const api = vi.hoisted(() => ({ uploadProposalPdf: vi.fn() }));
vi.mock("../../features/commercial/api", () => api);
import ProposalPdfUploadDialog from "./ProposalPdfUploadDialog";

describe("Proposal PDF upload", () => {
  beforeEach(() => vi.clearAllMocks());
  it("imports a new proposal with the chosen title and opens the returned proposal", async () => {
    const onUploaded = vi.fn();
    const created = { id: "proposal-created" } as CommercialProposal;
    api.uploadProposalPdf.mockResolvedValue({ proposal: created });
    const user = userEvent.setup();
    render(<ProposalPdfUploadDialog onClose={vi.fn()} onUploaded={onUploaded}/>);
    const file = new File(["%PDF-1.7 example"], "Oferta comercial.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Arquivo PDF da proposta"), file);
    expect(screen.getByLabelText("Título da proposta")).toHaveValue("Oferta comercial");
    await user.click(screen.getByRole("button", { name: "Enviar e editar" }));
    await waitFor(() => expect(api.uploadProposalPdf).toHaveBeenCalledWith(file, expect.objectContaining({ title: "Oferta comercial", signed: false }), undefined));
    expect(onUploaded).toHaveBeenCalledWith(created);
  });
  it("attaches a signed PDF to the existing proposal with its concurrency version", async () => {
    const proposal = { id: "existing", title: "Proposta existente", version: 7 } as CommercialProposal;
    api.uploadProposalPdf.mockRejectedValue(new Error("A proposta mudou. Reabra o documento."));
    const onUploaded = vi.fn();
    const user = userEvent.setup();
    render(<ProposalPdfUploadDialog proposal={proposal} initialSigned onClose={vi.fn()} onUploaded={onUploaded}/>);
    const file = new File(["%PDF-1.7 signed"], "assinada.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Arquivo PDF da proposta"), file);
    await user.click(screen.getByRole("button", { name: "Enviar e registrar assinatura" }));
    expect(api.uploadProposalPdf).toHaveBeenCalledWith(file, expect.objectContaining({ signed: true, expectedVersion: 7 }), "existing");
    expect(await screen.findByRole("alert")).toHaveTextContent("A proposta mudou");
    expect(onUploaded).not.toHaveBeenCalled();
    expect(screen.getByText("assinada.pdf")).toBeInTheDocument();
  });
});
