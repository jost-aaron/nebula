import { apiJson } from "./http";

export const JOB_STATES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export const JOB_TYPES = ["scan", "probe", "metadata", "artwork", "cleanup", "rendition"] as const;

export type JobState = (typeof JOB_STATES)[number];
export type JobType = (typeof JOB_TYPES)[number];

export interface BackgroundJob {
  attempt: number;
  availableAt: string;
  cancelRequestedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  currentStage: string | null;
  dedupeKey: string | null;
  error: { code: string | null; message: string } | null;
  id: string;
  maxAttempts: number;
  payload: Record<string, unknown>;
  progress: number;
  result: unknown;
  startedAt: string | null;
  state: JobState;
  type: JobType;
  updatedAt: string;
}

export interface EnqueueJobRequest {
  type: JobType;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
  maxAttempts?: number;
}

const queryString = (filters: { limit?: number; state?: JobState; type?: JobType }) => {
  const query = new URLSearchParams();
  query.set("limit", String(filters.limit ?? 100));
  if (filters.state) query.set("state", filters.state);
  if (filters.type) query.set("type", filters.type);
  return query.toString();
};

export const listJobs = (filters: { limit?: number; state?: JobState; type?: JobType } = {}) =>
  apiJson<{ jobs: BackgroundJob[] }>(`/api/jobs?${queryString(filters)}`);

export const enqueueJob = (request: EnqueueJobRequest) =>
  apiJson<{ created: boolean; job: BackgroundJob }>("/api/jobs", {
    method: "POST",
    body: JSON.stringify(request)
  });

export const cancelJob = (id: string) =>
  apiJson<{ job: BackgroundJob }>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
