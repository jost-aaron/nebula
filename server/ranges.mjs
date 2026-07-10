export const parseByteRange = (header, size) => {
  const unsatisfiable = { ok: false, contentRange: `bytes */${size}` };

  if (!Number.isSafeInteger(size) || size <= 0 || typeof header !== "string" || header.includes(",")) {
    return unsatisfiable;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header);

  if (!match || (!match[1] && !match[2])) {
    return unsatisfiable;
  }

  if (!match[1]) {
    const suffixLength = Number(match[2]);

    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return unsatisfiable;
    }

    const start = Math.max(size - suffixLength, 0);
    return { ok: true, start, end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start) {
    return unsatisfiable;
  }

  return { ok: true, start, end: Math.min(requestedEnd, size - 1) };
};
