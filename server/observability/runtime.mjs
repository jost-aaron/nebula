const SAFE_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "OTHER"]);
const statusClass = (status) => {
  const value = Math.floor(Number(status) / 100);
  return value >= 1 && value <= 5 ? `${value}xx` : "other";
};

export const createRuntimeTelemetry = ({ now = () => Date.now(), output = process.stdout } = {}) => {
  const requests = new Map();
  let errors = 0;

  const write = (level, event, fields = {}) => {
    output.write(`${JSON.stringify({ timestamp: new Date(now()).toISOString(), level, event, ...fields })}\n`);
  };
  const recordRequest = ({ method, status, durationMs }) => {
    const boundedMethod = SAFE_METHODS.has(method) ? method : "OTHER";
    const key = `${boundedMethod}:${statusClass(status)}`;
    const current = requests.get(key) ?? { count: 0, durationMs: 0 };
    current.count += 1;
    current.durationMs += Math.max(0, Number(durationMs) || 0);
    requests.set(key, current);
  };
  const recordError = (error, fields = {}) => {
    errors += 1;
    write("error", "server.error", {
      code: typeof error?.code === "string" ? error.code.slice(0, 64) : "UNEXPECTED_ERROR",
      errorType: error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : "Error",
      ...fields
    });
  };
  const snapshot = () => ({
    errors,
    memory: process.memoryUsage(),
    requests: [...requests.entries()].map(([key, value]) => {
      const [method, status] = key.split(":");
      return { method, status, ...value };
    })
  });
  return { recordError, recordRequest, snapshot, write };
};
