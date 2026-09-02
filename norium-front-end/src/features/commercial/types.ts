export type ProposalStatus =
  | "draft"
  | "in_review"
  | "changes_requested"
  | "approved"
  | "rejected"
  | "sent"
  | "viewed"
  | "negotiating"
  | "accepted"
  | "declined"
  | "expired"
  | "contracted"
  | "archived";

export type ContractStatus =
  | "draft"
  | "awaiting_signatures"
  | "signed"
  | "active"
  | "completed"
  | "cancelled";

export type SignerRole = "client" | "contractor" | "witness";
export type DocumentKind = "proposal" | "contract";
export type TemplateDocumentType = DocumentKind | "term" | "budget" | "report" | "custom";
export type PdfOperation =
  | "merge" | "split" | "reorder" | "delete_pages" | "rotate" | "compress"
  | "images_to_pdf" | "watermark" | "page_numbers" | "add_password" | "remove_password"
  | "ocr" | "extract_text" | "remove_metadata" | "sanitize" | "compare";
export type ProposalTone = "consultive" | "executive" | "technical" | "friendly";

export type ClientSnapshot = {
  id: string;
  document: string;
  name: string;
  company: string;
  email: string;
};

export type Branding = {
  logoUrl: string;
  logoAlignment: "left" | "center" | "right";
  logoScale: number;
  primaryColor: string;
  secondaryColor: string;
  textColor: string;
  headerHtml: string;
  footerHtml: string;
};

export type Signer = {
  id: string;
  name: string;
  email: string;
  role: SignerRole;
  order: number;
  required: boolean;
  status: "pending" | "invited" | "signed";
  signedAt: string | null;
  invitedAt: string | null;
  invitationExpiresAt?: string | null;
  signatureDataUrl: string;
};

export type SignatureLink = {
  signerId: string;
  name: string;
  email: string;
  role: SignerRole;
  status: Signer["status"];
  expiresAt: string;
  url: string;
};

export type Deliverable = {
  title: string;
  description: string;
  dueDate: string | null;
  responsibleId: string;
  responsibleName: string;
  createCalendarEvent: boolean;
};

export type DocumentRevision = {
  id: string;
  version: number;
  title: string;
  contentHtml: string;
  branding: Omit<Branding, "logoUrl"> & { logoUrl?: string };
  savedBy: string;
  savedById: string;
  savedAt: string;
};

export type NoraSuggestion = {
  id: string;
  original: string;
  replacement: string;
  reason: string;
  severity: "info" | "warning" | "critical";
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
  decidedAt?: string;
};

export type NoraAnalysis = {
  summary: string;
  riskLevel: "low" | "medium" | "high";
  tone: string;
  context: string;
  focus: Array<"scope" | "risk" | "tone" | "commercial" | "legal" | "grammar">;
  analyzedAt: string;
};

export type CommercialProposal = {
  id: string;
  clientId: string;
  client: ClientSnapshot;
  brainstormId: string | null;
  contractId?: string;
  title: string;
  contentHtml: string;
  scopeSummary: string;
  amount: number;
  currency: string;
  validUntil: string | null;
  brandProfileId: string | null;
  branding: Branding;
  signers: Signer[];
  deliverables: Deliverable[];
  metadata: Record<string, unknown>;
  status: ProposalStatus;
  approval: {
    status: "pending" | "approved" | "rejected";
    note?: string;
    decisionNote?: string;
    requestedByName?: string;
    decidedByName?: string;
  } | null;
  noraAnalysis: NoraAnalysis | null;
  suggestions: NoraSuggestion[];
  version: number;
  revisions: DocumentRevision[];
  events?: DocumentEvent[];
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

export type AuditTrailEntry = {
  id: string;
  action: string;
  signerId: string;
  signerRole: SignerRole;
  emailHash: string;
  ip: string;
  userAgent: string;
  actorId: string;
  timestamp: string;
};

export type CommercialContract = {
  id: string;
  proposalId: string;
  clientId: string;
  client: ClientSnapshot;
  brainstormId: string | null;
  title: string;
  contentHtml: string;
  scopeSummary: string;
  amount: number;
  currency: string;
  branding: Branding;
  signers: Signer[];
  deliverables: Deliverable[];
  status: ContractStatus;
  version: number;
  revisions: DocumentRevision[];
  auditTrail: AuditTrailEntry[];
  events?: DocumentEvent[];
  tasksCreated: Array<{ id: string; title: string; dueDate: string | null }>;
  calendarEventsCreated: Array<{ id: string; title: string; start?: string; error?: string }>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  signedAt?: string;
  activatedAt?: string;
  metadata?: Record<string, unknown>;
};

export type BrandProfile = {
  id: string;
  name: string;
  branding: Branding;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CommercialTemplate = {
  id: string;
  name: string;
  description: string;
  contentHtml: string;
  shared: boolean;
  category: string;
  documentType: TemplateDocumentType;
  active: boolean;
  isDefault: boolean;
  variables: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type CommercialSummary = {
  documentCount: number;
  proposalCount: number;
  draftCount: number;
  reviewCount: number;
  approvedCount: number;
  negotiationCount: number;
  contractCount: number;
  awaitingSignatureCount: number;
  signedCount: number;
  expiringCount: number;
  archivedCount: number;
  fileCount: number;
  planMode: "solo" | "enterprise";
  requiresApproval: boolean;
  maxBrandProfiles: number | null;
};

export type CommercialProposalSummary = Pick<
  CommercialProposal,
  "id" | "client" | "brainstormId" | "contractId" | "title" | "amount" | "currency" | "status" | "updatedAt"
> & {
  documentType: "proposal";
  primaryColor: string;
  favorite: boolean;
  category: "proposals";
  validUntil?: string | null;
};

export type CommercialContractSummary = Pick<
  CommercialContract,
  "id" | "proposalId" | "client" | "brainstormId" | "title" | "amount" | "currency" | "status" | "updatedAt"
> & {
  documentType: "contract";
  primaryColor: string;
  favorite: boolean;
  category: "contracts";
};

export type CommercialDocumentSummary = CommercialProposalSummary | CommercialContractSummary;

export type CommercialData = {
  proposals: CommercialProposalSummary[];
  contracts: CommercialContractSummary[];
  brandProfiles: BrandProfile[];
  templates: CommercialTemplate[];
  uploadedDocuments: UploadedDocument[];
  processingJobs: PdfProcessingJob[];
  summary: CommercialSummary;
};

export type DocumentEvent = {
  id: string;
  action: string;
  label: string;
  note?: string;
  metadata?: Record<string, unknown>;
  actorId: string;
  actorName: string;
  timestamp: string;
};

export type UploadedDocument = {
  id: string;
  documentType: "pdf" | "image" | "text";
  title: string;
  originalFileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  category: "pdf" | "sent" | "received" | "draft" | "archived";
  direction: "internal" | "sent" | "received";
  status: "ready" | "processing";
  favorite: boolean;
  archived: boolean;
  confidential: boolean;
  scanStatus: string;
  securityReviewRequired: boolean;
  events: DocumentEvent[];
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

export type PdfProcessingJob = {
  id: string;
  operation: PdfOperation;
  label: string;
  documentIds: string[];
  options: Record<string, unknown>;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  progress: number;
  attempts: number;
  maxAttempts: number;
  cancelRequested: boolean;
  outputDocumentIds: string[];
  message: string;
  createdAt: string;
  updatedAt: string;
};

export type PdfCapabilities = {
  operations: Array<{ id: PdfOperation; label: string; engine: "native" | "stirling" }>;
  stirling: { configured: boolean; available: boolean; operations: PdfOperation[]; message: string };
  maxUploadBytes: number;
  asynchronous: boolean;
};

export type ClientOption = {
  id: string;
  name: string;
  company: string;
  document?: string;
  email: string;
};

export type BrainstormOption = {
  id: string;
  title: string;
  objective?: string;
  status?: string;
};

export type ProposalBriefInput = {
  clientId: string;
  brainstormId: string | null;
  title: string;
  objective: string;
  scopeNotes: string;
  team: string;
  deadline: string;
  deliverablesNotes: string;
  exclusions: string;
  notes: string;
  amount: number;
  currency: string;
  tone: ProposalTone;
};

export type ProposalDraft = {
  title: string;
  scopeSummary: string;
  expandedScope: string;
  teamPlan: string;
  timeline: string;
  deliverables: Deliverable[];
  exclusions: string;
  notes: string;
  noraComment: string;
  contentHtml: string;
  client: ClientSnapshot;
  amount: number;
  currency: string;
  brainstormId: string | null;
  briefing: ProposalBriefInput;
};

export type CommercialDocument = CommercialProposal | CommercialContract;

export const defaultBranding: Branding = {
  logoUrl: "",
  logoAlignment: "left",
  logoScale: 100,
  primaryColor: "#1E293B",
  secondaryColor: "#3B82F6",
  textColor: "#0F172A",
  headerHtml: "",
  footerHtml: "",
};

export function isProposal(document: CommercialDocument): document is CommercialProposal {
  return "approval" in document;
}

export function commercialDocumentSummary(document: CommercialDocument): CommercialDocumentSummary {
  const base = {
    id: document.id,
    client: document.client,
    brainstormId: document.brainstormId,
    title: document.title,
    amount: document.amount,
    currency: document.currency,
    updatedAt: document.updatedAt,
    primaryColor: document.branding?.primaryColor || defaultBranding.primaryColor,
    favorite: Boolean(document.metadata?.favorite),
  };
  return isProposal(document)
    ? { ...base, documentType: "proposal", contractId: document.contractId, status: document.status, category: "proposals", validUntil: document.validUntil }
    : { ...base, documentType: "contract", proposalId: document.proposalId, status: document.status, category: "contracts" };
}
