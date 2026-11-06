import type { JobRecord } from "@/lib/data/repositories";
import type { Capability } from "@/lib/providers/types";

/**
 * How many jobs one user may have running at the same time: at most 3 in total and at most 2 of them videos
 * (so 3 images, or 1 video + 2 images, or 2 videos + 1 image).
 */
export const MAX_ACTIVE_JOBS = 3;
export const MAX_ACTIVE_VIDEOS = 2;

/**
 * A job that never finished (a crashed request, a task nobody looked at again) must not block the user forever,
 * so a job only counts while it is younger than this. Images finish within one request (max 5 minutes); videos
 * can take longer.
 */
export const ACTIVE_WINDOW_MS = { image: 10 * 60_000, video: 45 * 60_000 } as const;

const ACTIVE_STATUSES = new Set<JobRecord["status"]>(["queued", "submitted", "processing", "validating"]);

export const isVideoCapability = (c: Capability) => c.includes("video");

export interface ConcurrencyVerdict {
  allowed: boolean;
  reason?: string;
  active: { total: number; videos: number };
}

/** Pure: decides from the user's recent jobs whether one more job of `incoming` may start now. */
export function concurrencyVerdict(recent: Pick<JobRecord, "status" | "capability" | "createdAt">[], incoming: Capability, now: number): ConcurrencyVerdict {
  let total = 0;
  let videos = 0;
  for (const job of recent) {
    if (!ACTIVE_STATUSES.has(job.status)) continue;
    const video = isVideoCapability(job.capability);
    const age = now - Date.parse(job.createdAt);
    if (Number.isFinite(age) && age > ACTIVE_WINDOW_MS[video ? "video" : "image"]) continue;
    total += 1;
    if (video) videos += 1;
  }
  const active = { total, videos };
  if (total >= MAX_ACTIVE_JOBS) {
    return { allowed: false, active, reason: `You already have ${total} jobs running (the limit is ${MAX_ACTIVE_JOBS} at once, at most ${MAX_ACTIVE_VIDEOS} of them videos). Wait for one to finish; the Library shows their progress.` };
  }
  if (isVideoCapability(incoming) && videos >= MAX_ACTIVE_VIDEOS) {
    return { allowed: false, active, reason: `You already have ${videos} videos running (at most ${MAX_ACTIVE_VIDEOS} at once). Start an image instead, or wait for a video to finish.` };
  }
  return { allowed: true, active };
}
