import { apiBlobRequest, apiRequest } from "../../core/api/client";
import type {
  Branding,
  BrandProfile,
  CommercialContract,
  CommercialData,
  CommercialProposal,
  CommercialTemplate,
  Deliverable,
  PdfCapabilities,
  PdfOperation,
  PdfProcessingJob,
  ProposalBriefInput,
  ProposalDraft,
  SignatureLink,
  Signer,
  TemplateDocumentType,
  UploadedDocument,
} from "./types";

export type ProposalCreateInput = {
  clientId: string;
  brainstormId: string | null;
  title: string;
  contentHtml: string;
  scopeSummary: string;
  amount: number;
  currency: string;
  validUntil: string | null;
  brandProfileId: string | null;
  branding: Branding;
  signers: Array<Omit<Signer, "id" | "status" | "signedAt" | "invitedAt" | "signatureDataUrl">>;
  deliverables: Deliverable[];
  metadata: Record<string, unknown>;
};

export type DocumentUpdateInput = {
  expectedVersion: number;
  title?: string;
  contentHtml?: string;
  scopeSummary?: string;
  amount?: number;
  currency?: string;
  validUntil?: string | null;
  branding?: Branding;
  signers?: Array<Omit<Signer, "id" | "status" | "signedAt" | "invitedAt" | "signatureDataUrl">>;
  deliverables?: Deliverable[];
};

export function loadCommercialData(signal?: AbortSignal) {
  return apiRequest<CommercialData>("/api/comercial", { signal });
}

export function loadProposal(id: string, signal?: AbortSignal) {
  return apiRequest<{ proposal: CommercialProposal }>(`/api/comercial/proposals/${id}`, { signal });
}

export function loadContract(id: string, signal?: AbortSignal) {
  return apiRequest<{ contract: CommercialContract }>(`/api/comercial/contracts/${id}`, { signal });
}

export function createProposal(input: ProposalCreateInput) {
  return apiRequest<{ proposal: CommercialProposal }>("/api/comercial/proposals", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function generateProposalDraft(input: ProposalBriefInput) {
  return apiRequest<{ draft: ProposalDraft }>("/api/comercial/proposal-draft", {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: 60_000,
  });
}

export function deleteProposal(id: string) {
  return apiRequest<{ ok: boolean; proposal: CommercialProposal }>(`/api/comercial/proposals/${id}`, {
    method: "DELETE",
  });
}

export function duplicateProposal(id: string, title?: string) {
  return apiRequest<{ proposal: CommercialProposal }>(`/api/comercial/proposals/${id}/duplicate`, {
    method: "POST",
    body: JSON.stringify({ title: title || null }),
  });
}

export function changeProposalStatus(id: string, status: CommercialProposal["status"], note = "") {
  return apiRequest<{ proposal: CommercialProposal }>(`/api/comercial/proposals/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status, note }),
  });
}

export function updateProposal(id: string, input: DocumentUpdateInput) {
  return apiRequest<{ proposal: CommercialProposal }>(`/api/comercial/proposals/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function updateContract(id: string, input: DocumentUpdateInput) {
  const { scopeSummary: _scopeSummary, amount: _amount, currency: _currency, validUntil: _validUntil, deliverables: _deliverables, ...payload } = input;
  return apiRequest<{ contract: CommercialContract }>(`/api/comercial/contracts/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function submitProposal(id: string, note = "") {
  return apiRequest<{ proposal: CommercialProposal }>(`/api/comercial/proposals/${id}/submit`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

export function decideProposal(id: string, decision: "approve" | "request-changes", note = "") {
  return apiRequest<{ proposal: CommercialProposal }>(
    `/api/comercial/proposals/${id}/${decision}`,
    { method: "POST", body: JSON.stringify({ note }) },
  );
}

export function analyzeProposal(
  id: string,
  context: string,
  focus: Array<"scope" | "risk" | "tone" | "commercial" | "legal" | "grammar">,
) {
  return apiRequest<{ proposal: CommercialProposal }>(`/api/comercial/proposals/${id}/nora-analysis`, {
    method: "POST",
    body: JSON.stringify({ context, focus }),
    timeoutMs: 60_000,
  });
}

export function writeWithNora(
  documentType: "proposal" | "contract",
  id: string,
  input: { instruction: string; selectedText: string; mode: "insert" | "expand" | "rewrite" },
) {
  const collection = documentType === "proposal" ? "proposals" : "contracts";
  return apiRequest<{ contentHtml: string; comment: string }>(`/api/comercial/${collection}/${id}/nora-write`, {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: 60_000,
  });
}

export function shareCommercialDocument(
  documentType: "proposal" | "contract",
  id: string,
  input: {
    channel: "email" | "team";
    recipient?: string;
    subject?: string;
    message?: string;
  },
) {
  const collection = documentType === "proposal" ? "proposals" : "contracts";
  return apiRequest<{ ok: boolean; channel: "email" | "team"; recipient?: string; messageId: string }>(
    `/api/comercial/${collection}/${id}/share`,
    {
      method: "POST",
      body: JSON.stringify(input),
      timeoutMs: 60_000,
    },
  );
}

export function cancelContract(id: string) {
  return apiRequest<{ contract: CommercialContract }>(`/api/comercial/contracts/${id}/cancel`, {
    method: "POST",
  });
}

export function deleteContract(id: string) {
  return apiRequest<{ ok: boolean; contract: CommercialContract; proposal?: CommercialProposal | null }>(`/api/comercial/contracts/${id}`, {
    method: "DELETE",
  });
}

export function exportCommercialDocumentPdf(documentType: "proposal" | "contract", id: string) {
  const collection = documentType === "proposal" ? "proposals" : "contracts";
  return apiBlobRequest(`/api/comercial/${collection}/${id}/pdf`, { timeoutMs: 60_000 });
}

export function decideSuggestion(id: string, suggestionId: string, decision: "accepted" | "rejected") {
  return apiRequest<{ proposal: CommercialProposal }>(
    `/api/comercial/proposals/${id}/suggestions/${suggestionId}`,
    { method: "POST", body: JSON.stringify({ decision }) },
  );
}

export function generateContract(id: string, templateId?: string, title?: string) {
  return apiRequest<{ contract: CommercialContract; proposal: CommercialProposal }>(
    `/api/comercial/proposals/${id}/contract`,
    { method: "POST", body: JSON.stringify({ title: title || null, templateId: templateId || null }) },
  );
}

export function sendContractForSignature(id: string) {
  return apiRequest<{ contract: CommercialContract; signatureLinks: SignatureLink[] }>(`/api/comercial/contracts/${id}/send-for-signature`, {
    method: "POST",
  });
}

export function signContract(id: string, signerId: string, input: { name: string; email: string; consent: boolean; signatureDataUrl: string }) {
  return apiRequest<{ contract: CommercialContract }>(`/api/comercial/contracts/${id}/signers/${signerId}/sign`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function instantiateContract(id: string, projectId: string, projectName: string, createCalendarEvents: boolean) {
  return apiRequest<{
    contract: CommercialContract;
    tasks: Array<{ id: string; title: string; dueDate: string | null }>;
    calendarEvents: Array<{ id: string; title: string; start?: string; error?: string }>;
    alreadyInstantiated: boolean;
  }>(`/api/comercial/contracts/${id}/instantiate`, {
    method: "POST",
    body: JSON.stringify({ projectId, projectName, createCalendarEvents }),
  });
}

export function createBrandProfile(name: string, branding: Branding, isDefault: boolean) {
  return apiRequest<{ brandProfile: BrandProfile }>("/api/comercial/brand-profiles", {
    method: "POST",
    body: JSON.stringify({ name, branding, isDefault }),
  });
}

export function createTemplate(
  name: string,
  description: string,
  contentHtml: string,
  shared: boolean,
  category = "geral",
  documentType: TemplateDocumentType = "proposal",
  options: { active?: boolean; isDefault?: boolean; variables?: string[] } = {},
) {
  return apiRequest<{ template: CommercialTemplate }>("/api/comercial/templates", {
    method: "POST",
    body: JSON.stringify({ name, description, contentHtml, shared, category, documentType, ...options }),
  });
}

export function updateTemplate(id: string, input: Partial<Omit<CommercialTemplate, "id" | "createdBy" | "createdAt" | "updatedAt">>) {
  return apiRequest<{ template: CommercialTemplate }>(`/api/comercial/templates/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function duplicateTemplate(id: string, title?: string) {
  return apiRequest<{ template: CommercialTemplate }>(`/api/comercial/templates/${id}/duplicate`, {
    method: "POST",
    body: JSON.stringify({ title: title || null }),
  });
}

export function deleteTemplate(id: string) {
  return apiRequest<{ ok: boolean; template: CommercialTemplate }>(`/api/comercial/templates/${id}`, {
    method: "DELETE",
  });
}

export function importDocument(input: {
  fileName: string;
  mimeType: "application/pdf" | "image/png" | "image/jpeg" | "image/webp";
  dataBase64: string;
  category: UploadedDocument["category"];
  direction: UploadedDocument["direction"];
  confidential: boolean;
}) {
  return apiRequest<{ document: UploadedDocument }>("/api/comercial/documents/import", {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: 60_000,
  });
}

export function updateImportedDocument(id: string, input: Partial<Pick<UploadedDocument, "title" | "category" | "favorite" | "archived" | "confidential">>) {
  return apiRequest<{ document: UploadedDocument }>(`/api/comercial/documents/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteImportedDocument(id: string) {
  return apiRequest<{ ok: boolean; document: UploadedDocument }>(`/api/comercial/documents/${id}`, { method: "DELETE" });
}

export function downloadImportedDocument(id: string) {
  return apiBlobRequest(`/api/comercial/documents/${id}/download`, { timeoutMs: 60_000 });
}

export function loadPdfCapabilities() {
  return apiRequest<PdfCapabilities>("/api/comercial/pdf/capabilities", { timeoutMs: 15_000 });
}

export function processPdf(operation: PdfOperation, documentIds: string[], options: Record<string, unknown> = {}) {
  return apiRequest<{ job: PdfProcessingJob }>("/api/comercial/pdf/process", {
    method: "POST",
    body: JSON.stringify({ operation, documentIds, options }),
  });
}

export function loadPdfJob(id: string) {
  return apiRequest<{ job: PdfProcessingJob }>(`/api/comercial/pdf/jobs/${id}`);
}

export function cancelPdfJob(id: string) {
  return apiRequest<{ job: PdfProcessingJob }>(`/api/comercial/pdf/jobs/${id}/cancel`, { method: "POST" });
}
