import { apiBlobRequest, apiRequest } from "../../core/api/client";
import type {
  Branding,
  BrandProfile,
  CommercialContract,
  CommercialData,
  CommercialProposal,
  CommercialTemplate,
  Deliverable,
  ProposalBriefInput,
  ProposalDraft,
  SignatureLink,
  Signer,
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
  documentType: "proposal" | "contract" = "proposal",
) {
  return apiRequest<{ template: CommercialTemplate }>("/api/comercial/templates", {
    method: "POST",
    body: JSON.stringify({ name, description, contentHtml, shared, category, documentType }),
  });
}
