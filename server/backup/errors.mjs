export class BackupError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "BackupError";
    this.code = code;
    this.status = code === "cancelled" ? 499 : 400;
    this.expose = true;
  }
}

export const throwIfAborted = (signal) => {
  if (signal?.aborted) throw new BackupError("cancelled", "Backup operation was cancelled.");
};
