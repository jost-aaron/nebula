export interface MultiOriginSegment {
  byteLength: number;
  name: string;
  sha256: string;
}

export interface MultiOriginHlsContract {
  expiresAt: string;
  origins: Array<{ endpoint: string; nodeId: string; ticketUrl: string }>;
  segmentMap: MultiOriginSegment[];
}

interface LoaderCallbacks {
  onError(response: { code: number; text: string }, context: unknown, details?: unknown): void;
  onSuccess(response: { data: ArrayBuffer; url: string }, stats: Record<string, number>, context: unknown, networkDetails?: unknown): void;
  onTimeout(stats: Record<string, number>, context: unknown, networkDetails?: unknown): void;
}

interface LoaderContext { url: string }
interface LoaderConfig { maxLoadTimeMs?: number }
type FetchLike = typeof fetch;

const SHA256 = /^[a-f0-9]{64}$/;
const TICKET_PATH = /^\/api\/shard\/v1\/media\/[A-Za-z0-9_-]+\/hls\/master\.m3u8$/;
const segmentName = (url: string) => new URL(url, globalThis.location?.href ?? "https://nebula.invalid/").pathname.split("/").at(-1) ?? "";
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");

export const multiOriginHlsClientExperimentEnabled = (value?: string) => value === "true";

async function readBounded(response: Response, maximum: number): Promise<ArrayBuffer> {
  if (!response.body) throw new Error("Segment response has no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel("Segment exceeds the response bound.");
        throw new Error("Segment exceeds the response bound.");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

export function createVerifiedMultiOriginFetcher(contract: MultiOriginHlsContract, {
  fetcher = globalThis.fetch,
  maxBodyBytes = 16 * 1024 * 1024,
  maxRetries = contract.origins.length - 1,
  timeoutMs = 8_000
}: { fetcher?: FetchLike; maxBodyBytes?: number; maxRetries?: number; timeoutMs?: number } = {}) {
  if (!Array.isArray(contract.origins) || contract.origins.length < 2 || contract.origins.length > 4) throw new Error("Invalid multi-origin contract.");
  const segments = new Map(contract.segmentMap.map((entry) => [entry.name, entry]));
  if (segments.size !== contract.segmentMap.length || [...segments.values()].some((entry) => !SHA256.test(entry.sha256)
    || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 1 || entry.byteLength > maxBodyBytes)) {
    throw new Error("Invalid multi-origin segment map.");
  }
  const approved = contract.origins.map((origin) => {
    const endpoint = new URL(origin.endpoint);
    const ticket = new URL(origin.ticketUrl);
    if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".ts.net") || ticket.origin !== endpoint.origin
      || !TICKET_PATH.test(ticket.pathname) || [...ticket.searchParams.keys()].length !== 1 || !ticket.searchParams.get("ticket")) {
      throw new Error("Invalid multi-origin origin.");
    }
    return { ...origin, endpoint: endpoint.origin, ticket };
  });
  let nextOrigin = 0;
  const inflight = new Map<string, Promise<{ data: ArrayBuffer; url: string }>>();

  const load = (name: string, externalSignal?: AbortSignal) => {
    const expected = segments.get(name);
    if (!expected) return Promise.reject(new Error("Segment is not approved by the coordinator."));
    if (Date.now() >= Date.parse(contract.expiresAt)) return Promise.reject(new Error("Multi-origin session expired."));
    const existing = inflight.get(name);
    if (existing) return existing;
    const operation = (async () => {
      let lastError: unknown;
      const attempts = Math.min(approved.length, Math.max(1, maxRetries + 1));
      for (let offset = 0; offset < attempts; offset += 1) {
        const origin = approved[(nextOrigin + offset) % approved.length];
        const url = new URL(name, origin.ticket);
        url.search = origin.ticket.search;
        const controller = new AbortController();
        const abort = () => controller.abort(externalSignal?.reason);
        externalSignal?.addEventListener("abort", abort, { once: true });
        const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetcher(url, {
            cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal
          });
          if (!response.ok) throw new Error("Origin rejected the segment.");
          const declared = Number(response.headers.get("content-length"));
          if (Number.isFinite(declared) && declared > maxBodyBytes) throw new Error("Segment exceeds the response bound.");
          const data = await readBounded(response, Math.min(maxBodyBytes, expected.byteLength));
          if (data.byteLength !== expected.byteLength || data.byteLength > maxBodyBytes) throw new Error("Segment length failed integrity verification.");
          const digest = hex(await globalThis.crypto.subtle.digest("SHA-256", data));
          if (digest !== expected.sha256) throw new Error("Segment digest failed integrity verification.");
          nextOrigin = (nextOrigin + offset + 1) % approved.length;
          return { data, url: url.toString() };
        } catch (error) {
          lastError = error;
        } finally {
          globalThis.clearTimeout(timer);
          externalSignal?.removeEventListener("abort", abort);
        }
      }
      throw lastError instanceof Error ? lastError : new Error("All approved origins failed.");
    })().finally(() => inflight.delete(name));
    inflight.set(name, operation);
    return operation;
  };
  return { load };
}

export function createMultiOriginHlsLoader(
  contract: MultiOriginHlsContract,
  dependencies: Parameters<typeof createVerifiedMultiOriginFetcher>[1] = {},
  { enabled = multiOriginHlsClientExperimentEnabled() }: { enabled?: boolean } = {}
) {
  if (!enabled) throw new Error("The multi-origin HLS client experiment is disabled.");
  const verified = createVerifiedMultiOriginFetcher(contract, dependencies);
  return class VerifiedMultiOriginLoader {
    private controller: AbortController | null = null;
    abort() { this.controller?.abort(); }
    destroy() { this.abort(); this.controller = null; }
    load(context: LoaderContext, config: LoaderConfig, callbacks: LoaderCallbacks) {
      this.abort();
      this.controller = new AbortController();
      let delivered = false;
      const started = performance.now();
      verified.load(segmentName(context.url), this.controller.signal).then(({ data, url }) => {
        if (delivered || this.controller?.signal.aborted) return;
        delivered = true;
        callbacks.onSuccess({ data, url }, { loading: { start: started, end: performance.now() } } as unknown as Record<string, number>, context);
      }).catch((error) => {
        if (delivered) return;
        delivered = true;
        if (this.controller?.signal.aborted || error?.name === "AbortError") callbacks.onTimeout({}, context);
        else callbacks.onError({ code: 0, text: "Verified segment loading failed." }, context);
      });
    }
    getCacheAge() { return null; }
    getResponseHeader() { return null; }
  };
}
