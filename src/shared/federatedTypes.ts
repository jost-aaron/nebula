import type { CatalogId, MediaItemKind, MediaSourceKind } from "./catalogTypes";
import type { RenditionProfileId } from "./renditionTypes";

export type FederatedAvailability = "available" | "offline" | "stale";
export type FederatedNodeState = "online" | "stale" | "offline" | "draining" | "revoked";

export interface FederatedSourceAvailability {
  availability: "available" | "stale";
  capabilities: {
    directPlay: boolean;
    renditionProfiles: RenditionProfileId[];
    transcode: boolean;
  };
  height: number | null;
  id: string;
  local: boolean;
  localItemId: CatalogId;
  localSourceId: CatalogId;
  nodeName: string;
  nodeState: FederatedNodeState;
  renditions: Array<{ profileId: RenditionProfileId; revision: number; state: "pending" | "ready" | "failed" }>;
  sourceRevision: number;
  width: number | null;
}

export interface FederatedAvailabilitySummary {
  availability: FederatedAvailability;
  id: string;
  itemKind: MediaItemKind;
  mediaKind: MediaSourceKind;
  nodeCount: number;
  sourceCount: number;
  sources: FederatedSourceAvailability[];
  title: string;
  year: number | null;
}
