import type { JobCapability } from "@/lib/jobs/types";

export type ProviderCredentialInput = {
  apiKey: string;
};

export type ProviderModel = {
  providerId: string;
  modelKey: string;
  displayName: string;
  capabilities: JobCapability[];
  inputTypes: string[];
  outputTypes: string[];
  availability: "available" | "limited" | "unavailable" | "unverified";
};

export type CostEstimate = {
  amount: number;
  currency: string;
  basis: string;
  verifiedAt: string;
};

export type SubmitJobInput = {
  capability: JobCapability;
  modelKey: string;
  prompt?: string;
  inputAssetUrls: string[];
  parameters: Record<string, unknown>;
  idempotencyKey: string;
};

export type ProviderJobStatus =
  | "submitted"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface ProviderAdapter {
  readonly id: string;
  validateCredentials(input: ProviderCredentialInput): Promise<boolean>;
  listModels(): Promise<ProviderModel[]>;
  estimateCost(input: SubmitJobInput): Promise<CostEstimate | null>;
  submitJob(input: SubmitJobInput, credential: ProviderCredentialInput): Promise<{ providerJobId: string }>;
  getJobStatus(providerJobId: string, credential: ProviderCredentialInput): Promise<{
    status: ProviderJobStatus;
    outputUrls?: string[];
    errorCode?: string;
    errorMessage?: string;
    actualCost?: number;
    currency?: string;
  }>;
  cancelJob?(providerJobId: string, credential: ProviderCredentialInput): Promise<void>;
}
