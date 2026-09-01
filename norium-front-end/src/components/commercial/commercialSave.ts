import type { DocumentUpdateInput } from "../../features/commercial/api";
import type { Branding, CommercialDocument, Deliverable, Signer } from "../../features/commercial/types";
import { isProposal } from "../../features/commercial/types";

export type DocumentDraft = {
  title: string;
  contentHtml: string;
  scopeSummary: string;
  amount: number;
  currency: string;
  validUntil: string | null;
  branding: Branding;
  signers: Signer[];
  deliverables: Deliverable[];
};

export function documentDraft(document: CommercialDocument): DocumentDraft {
  return {
    title: document.title,
    contentHtml: document.contentHtml,
    scopeSummary: document.scopeSummary,
    amount: document.amount,
    currency: document.currency,
    validUntil: isProposal(document) ? document.validUntil : null,
    branding: document.branding,
    signers: document.signers,
    deliverables: document.deliverables,
  };
}

export function draftSnapshot(draft: DocumentDraft) {
  return JSON.stringify(draft);
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function changedDocumentInput(current: DocumentDraft, saved: DocumentDraft, expectedVersion: number): DocumentUpdateInput {
  const input: DocumentUpdateInput = { expectedVersion };
  if (current.title !== saved.title) input.title = current.title;
  if (current.contentHtml !== saved.contentHtml) input.contentHtml = current.contentHtml;
  if (current.scopeSummary !== saved.scopeSummary) input.scopeSummary = current.scopeSummary;
  if (current.amount !== saved.amount) input.amount = current.amount;
  if (current.currency !== saved.currency) input.currency = current.currency;
  if (current.validUntil !== saved.validUntil) input.validUntil = current.validUntil;
  if (!sameValue(current.branding, saved.branding)) input.branding = current.branding;
  if (!sameValue(current.signers, saved.signers)) {
    input.signers = current.signers.map(({ name, email, role, order, required }) => ({ name, email, role, order, required }));
  }
  if (!sameValue(current.deliverables, saved.deliverables)) input.deliverables = current.deliverables;
  return input;
}
