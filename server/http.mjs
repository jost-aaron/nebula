export const json = (response, status, data) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(data));
};

export const JSON_BODY_LIMIT = 1024 * 1024;

export const readBody = async (request, { limit = JSON_BODY_LIMIT } = {}) => {
  const declaredLength = Number(request.headers?.["content-length"] ?? 0);

  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    request.resume();
    throw Object.assign(new Error(`JSON request body exceeds the ${limit} byte limit.`), { status: 413 });
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > limit) {
      request.resume();
      throw Object.assign(new Error(`JSON request body exceeds the ${limit} byte limit.`), { status: 413 });
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body contains malformed JSON."), { status: 400 });
  }
};
