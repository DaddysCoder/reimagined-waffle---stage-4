export type DocumentStatus = "needs_review" | "approved" | "rejected" | "quarantined";

export type DocumentSource = {
  kind: "company_upload" | "regulatory";
  authority?: string;
  sourceUrl?: string;
  discoveredAt?: string;
  change?: "new" | "changed" | "unchanged" | "link_only" | "manual";
};

export type KnowledgeDocument = {
  id: string;
  name: string;
  originalName: string;
  mimeType: string;
  size: number;
  contentHash: string;
  status: DocumentStatus;
  uploadedAt: string;
  reviewedAt?: string;
  effectiveDate?: string;
  documentType?: string;
  source?: DocumentSource;
  inspection: {
    wordCount: number;
    possiblePersonalInfo: boolean;
    possibleSupersededLanguage: boolean;
    possibleSecrets: boolean;
    possiblePromptInjection: boolean;
    lowTextContent: boolean;
    notes: string[];
  };
};

export type Chunk = {
  id: string;
  documentId: string;
  index: number;
  text: string;
};

export type AuditEvent = {
  id: string;
  at: string;
  action: string;
  documentId?: string;
  detail: string;
};

export type Database = {
  documents: KnowledgeDocument[];
  chunks: Chunk[];
  audit: AuditEvent[];
};

export type RetrievalHit = {
  document: KnowledgeDocument;
  chunk: Chunk;
  score: number;
};
