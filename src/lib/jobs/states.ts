import type { JobStatus } from "@/lib/providers/types";

const allowedTransitions: Record<JobStatus, JobStatus[]> = {
  queued: ["submitted", "failed", "cancelled"],
  submitted: ["processing", "validating", "failed", "cancelled"],
  processing: ["processing", "validating", "failed", "cancelled"],
  validating: ["completed", "failed"],
  completed: [],
  failed: [],
  cancelled: []
};

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return allowedTransitions[from].includes(to);
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return ["completed", "failed", "cancelled"].includes(status);
}