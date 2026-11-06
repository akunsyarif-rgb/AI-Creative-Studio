export const CAPABILITIES = [
  "text_to_image", "image_to_image", "image_edit", "inpaint", "outpaint", "image_upscale",
  "text_to_video", "image_to_video", "video_to_video", "video_edit",
  "background_remove", "object_remove", "object_replace", "face_replace", "character_consistency"
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type JobStatus = "queued" | "submitted" | "processing" | "validating" | "completed" | "failed" | "cancelled";

export interface CostEstimate {
  /** `null` means the price is unknown (e.g. a custom provider without a user estimate). */
  amount: number | null;
  currency: string;
  isEstimate: true;
  notes?: string;
}

/** A user-facing option for a model parameter, rendered as a <select> by the UI. */
export interface ParameterOption {
  value: string;
  label: string;
}

/** Describes one tunable parameter so the UI can build its form from provider config alone. */
export interface ParameterSpec {
  key: string;
  label: string;
  options: ParameterOption[];
  default: string;
}

export interface ProviderModel {
  modelId: string;
  displayName: string;
  capabilities: Capability[];
  /** Tunable parameters beyond the prompt. */
  parameters?: ParameterSpec[];
  /** Left unset until pricing has been verified against the provider's live pricing. */
  pricingVerifiedAt?: string;
  isFreeTier?: boolean;
}

/** Static, non-secret description of a provider. Safe to send to the browser. */
export interface ProviderConfig {
  id: string;
  name: string;
  description?: string;
  availableModels: ProviderModel[];
}

export interface ProviderJobRequest {
  capability: Capability;
  modelId: string;
  inputAssetIds: string[];
  parameters: Record<string, unknown>;
}

export interface ProviderFile {
  contentType: string;
  data: Uint8Array;
}

/** Secrets and resolved inputs are passed per call, never stored on the adapter. */
export interface ProviderExecutionContext {
  secret: string;
  inputFiles: ProviderFile[];
}

export interface ProviderJobResult {
  providerJobId?: string;
  status: JobStatus;
  progress?: number;
  outputFiles?: ProviderFile[];
  estimatedCost?: CostEstimate;
}

export type ProviderErrorCode =
  | "auth" | "insufficient_funds" | "rate_limited" | "invalid_request" | "content_policy" | "timeout" | "unavailable" | "unknown";

/** Sanitized provider failure: `message` is safe to show to users and never contains provider payloads. */
export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    /** True only if it is known no billable work happened (safe to retry by hand). */
    public readonly outcomeKnown: boolean
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ProviderAdapter {
  readonly config: ProviderConfig;
  /** Union of the capabilities of all available models. */
  getCapabilities(): Capability[];
  /** Rejects unsupported parameters before any submission. Throws ProviderError("invalid_request"). */
  validateRequest(request: ProviderJobRequest): void;
  /** Checks a BYOK against the real provider API. Throws ProviderError if the result is unknown. */
  testKey(secret: string): Promise<{ valid: boolean; message?: string }>;
  estimateCost(request: ProviderJobRequest): Promise<CostEstimate | null>;
  /** Billable. Callers must never retry this automatically. */
  executeJob(request: ProviderJobRequest, idempotencyKey: string, context: ProviderExecutionContext): Promise<ProviderJobResult>;
  getJobStatus?(providerJobId: string, secret: string): Promise<ProviderJobResult>;
  cancelJob?(providerJobId: string): Promise<{ accepted: boolean }>;
}
