import { apiJson } from "./http";
import type { ClusterAdminNode, ClusterAdminSnapshot } from "../shared/clusterTypes";

export type ClusterNodeControlUpdate = {
  maintenanceDrain?: boolean;
  maxConcurrentStreams?: number | null;
  maxConcurrentTranscodes?: number | null;
  name?: string;
  priority?: number;
};

export const getClusterAdmin = () => apiJson<ClusterAdminSnapshot>("/api/admin/cluster");

export const updateClusterNode = (nodeId: string, controls: ClusterNodeControlUpdate) =>
  apiJson<{ node: ClusterAdminNode }>(`/api/admin/cluster/nodes/${encodeURIComponent(nodeId)}`, {
    body: JSON.stringify(controls),
    method: "PATCH"
  });
