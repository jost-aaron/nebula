import { apiJson } from "./http";

export type PlaybackPolicyLimits = { maxBitrate: number | null; maxConcurrentStreams: number | null };
export type PlaybackPolicyUser = {
  activeStreams: number;
  disabled: boolean;
  displayName: string;
  effective: PlaybackPolicyLimits;
  id: string;
  override: PlaybackPolicyLimits | null;
  username: string;
};
export type PlaybackPolicySnapshot = { activeStreams?: number; global: PlaybackPolicyLimits; users: PlaybackPolicyUser[] };

export const getPlaybackPolicy = () => apiJson<PlaybackPolicySnapshot>("/api/admin/playback-policy");
export const getPlaybackPolicyStatus = () => apiJson<Required<PlaybackPolicySnapshot>>("/api/admin/playback-policy/status");
export const saveGlobalPlaybackPolicy = (policy: PlaybackPolicyLimits) => apiJson<{ global: PlaybackPolicyLimits }>("/api/admin/playback-policy", {
  body: JSON.stringify(policy), method: "PUT"
});
export const saveUserPlaybackPolicy = (userId: string, policy: PlaybackPolicyLimits) => apiJson<{ policy: PlaybackPolicyLimits; userId: string }>(`/api/admin/playback-policy/users/${encodeURIComponent(userId)}`, {
  body: JSON.stringify(policy), method: "PUT"
});
