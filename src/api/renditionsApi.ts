import { apiJson } from "./http";
import type { RenditionProfilesResponse } from "../shared/renditionTypes";

export const listRenditionProfiles = () => apiJson<RenditionProfilesResponse>("/api/renditions/profiles");
