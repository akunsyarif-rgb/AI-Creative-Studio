export type Capability =
  | "text_to_image" | "image_to_image" | "image_edit" | "inpaint" | "outpaint" | "image_upscale"
  | "text_to_video" | "image_to_video" | "video_to_video" | "video_edit"
  | "background_remove" | "object_remove" | "object_replace" | "face_replace" | "character_consistency";

export type JobStatus = "queued" | "submitted" | "processing" | "validating" | "completed" | "failed" | "cancelled";

export interface CostEstimate {
  amount: number;
  currency: string;
  isEstimate: true;
  notes?: string;
}

export interface ProviderModel {
  providerId: string;
  modelId: string;
  displayName: string;
  capabilities: Capability[];
  pricingVerifiedAt?: string;
  isFreeTier?: boolean;
}

export interface ProviderJobRequest {
  capability: Capability;
  modelId: string;
  inputAssetIds: string[];
  parameters: Record<string, unknown>;
}

export interface ProviderJobResult {
  providerJobId: string;
  status: JobStatus;
  progress?: number;
  outputReferences?: string[];
  estimatedCost?: CostEstimate;
}

export interface ProviderAdapter {
  readonly providerId: string;
  capabilities(): Promise<Capability[]>;
  validateCredentials(secret: string): Promise<{ valid: boolean; message?: string }>;
  estimateCost(request: ProviderJobRequest): Promise<CostEstimate | null>;
  submitJob(request: ProviderJobRequest, idempotencyKey: string): Promise<ProviderJobResult>;
  getJobStatus(providerJobId: string): Promise<ProviderJobResult>;
  cancelJob?(providerJobId: string): Promise<{ accepted: boolean }>;
}