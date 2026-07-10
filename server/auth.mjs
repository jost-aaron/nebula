import { json } from "./http.mjs";

const localhostAddresses = new Set(["127.0.0.1", "::1"]);

const normalizedRemoteAddress = (request) =>
  (request.socket.remoteAddress ?? "").toLowerCase().replace(/^::ffff:/, "").split("%")[0];

export const createAuthGuard = () => {
  const required = process.env.NEBULA_REQUIRE_AUTH === "true";
  const token = process.env.NEBULA_API_TOKEN ?? "";

  return {
    required,
    async authorize(request, response) {
      if (!required) {
        return true;
      }

      const isLocalRequest = localhostAddresses.has(normalizedRemoteAddress(request));

      if (isLocalRequest && process.env.NEBULA_AUTH_ALLOW_LOCALHOST !== "false") {
        return true;
      }

      if (!token) {
        json(response, 503, { error: "API auth is enabled but no token is configured." });
        return false;
      }

      const authorization = request.headers.authorization ?? "";

      if (authorization === `Bearer ${token}`) {
        return true;
      }

      json(response, 401, { error: "Unauthorized." });
      return false;
    }
  };
};
