export const JOB_CAPABILITIES = [
  "text_to_image",
  "image_to_image",
  "image_edit",
  "inpaint",
  "outpaint",
  "upscale",
  "text_to_video",
  "image_to_video",
  "video_to_video",
  "video_extend",
  "video_edit",
  "background_remove",
  "background_replace",
  "object_remove",
  "face_replace",
  "character_replace",
] as const;

export type JobCapability = (typeof JOB_CAPABILITIES)[number];

export const JOB_STATUSES = [
  "queued",
  "submitted",
  "processing",
  "validating",
  "completed",
  "failed",
  "cancelled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export type JobRecord = {
  id: string;
  capability: JobCapability;
  status: JobStatus;
  providerId: string | null;
  modelId: string | null;
  estimatedCost: number | null;
  actualCost: number | null;
  createdAt: string;
  updatedAt: string;
};
