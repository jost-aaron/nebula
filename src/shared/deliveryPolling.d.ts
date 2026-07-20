export interface PollableDelivery {
  session: { id: string; status: string };
}

export class DeliveryPreparationTimeoutError extends Error {}

export function createAbortableDelay(options?: {
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): (delay: number, signal: AbortSignal) => Promise<void>;

export function pollDeliveryUntilReady<T extends PollableDelivery>(options: {
  initial: T;
  getStatus: (id: string, signal: AbortSignal) => Promise<T>;
  cancel: (id: string) => Promise<unknown>;
  signal: AbortSignal;
  timeoutMs?: number;
  initialDelayMs?: number;
  maximumDelayMs?: number;
  backoffFactor?: number;
  jitterRatio?: number;
  now?: () => number;
  random?: () => number;
  delay?: (delay: number, signal: AbortSignal) => Promise<void>;
}): Promise<T>;
