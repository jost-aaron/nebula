import { apiJson } from "./http";

export type AccelerationStatus = { mode: string; selectedBackend: string; decision: string; reason: string; lastProbeAt: string | null; active: { hardware: number; software: number }; backends: Array<{ name: string; available: boolean; encoderDetected: boolean; deviceDetected: boolean; selfTest: string; reason: string }> };
export const getAccelerationStatus = () => apiJson<AccelerationStatus>("/api/admin/transcode-acceleration");
export const saveAccelerationMode = (mode: string) => apiJson<AccelerationStatus>("/api/admin/transcode-acceleration", { method: "PUT", body: JSON.stringify({ mode }) });
export const refreshAcceleration = () => apiJson<AccelerationStatus>("/api/admin/transcode-acceleration", { method: "POST", body: "{}" });
