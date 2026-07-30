export type ProposalStatus =
  | "draft"
  | "in_review"
  | "changes_requested"
  | "approved"
  | "rejected"
  | "sent"
  | "accepted"
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
  branding: Branding;
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
  focus: Array<"scope" | "risk" | "tone" | "commercial" | "legal">;
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
  documentType: DocumentKind;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type CommercialSummary = {
  proposalCount: number;
  draftCount: number;
  reviewCount: number;
  approvedCount: number;
  contractCount: number;
  signedCount: number;
  planMode: "solo" | "enterprise";
  requiresApproval: boolean;
  maxBrandProfiles: number | null;
};

export type CommercialData = {
  proposals: CommercialProposal[];
  contracts: CommercialContract[];
  brandProfiles: BrandProfile[];
  templates: CommercialTemplate[];
  summary: CommercialSummary;
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
