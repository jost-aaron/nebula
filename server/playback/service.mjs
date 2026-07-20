import { randomUUID } from "node:crypto";
import { PLAYBACK_REPOSITORY_METHODS, requireMediaContract } from "../mediaContracts.mjs";

const EVENTS = new Set(["start", "progress", "pause", "stop", "complete"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const requireUuid = (value, label) => {
  if (typeof value !== "string" || !UUID.test(value)) throw badRequest(`${label} must be a UUID.`);
  return value;
};
const requireOpaqueId = (value, label) => {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) throw badRequest(`${label} must be a valid opaque identifier.`);
  return value;
};
const requireUser = (principal) => {
  if (!principal || principal.type === "service" || typeof principal.userId !== "string" || !principal.userId) {
    throw Object.assign(new Error("Authenticated user playback access is required."), { status: 403 });
  }
  return principal.userId;
};

export const createPlaybackService = ({
  compatibilityResolver = null,
  completionThreshold = 0.9,
  federatedIdentityValidator = null,
  identityValidator = null,
  now = () => Date.now(),
  progressIntervalMs = 10_000,
  progressPositionDelta = 10,
  repository,
  visibilityFilter = null,
  uuid = randomUUID
} = {}) => {
  requireMediaContract("playbackRepository", repository, PLAYBACK_REPOSITORY_METHODS);
  if (typeof repository.setWatched !== "function") throw new TypeError("playbackRepository.setWatched must be a function.");
  if (compatibilityResolver && typeof compatibilityResolver.resolveValidatedContentPath !== "function") {
    throw new TypeError("compatibilityResolver.resolveValidatedContentPath must be a function.");
  }
  if (identityValidator && typeof identityValidator !== "function") {
    throw new TypeError("identityValidator must be a function.");
  }
  if (federatedIdentityValidator && typeof federatedIdentityValidator !== "function") {
    throw new TypeError("federatedIdentityValidator must be a function.");
  }

  const resolveIdentity = async (request, principal) => {
    const hasFederated = request?.federatedIdentity != null;
    const hasLocal = request?.itemId != null || request?.sourceId != null || request?.contentPath != null;
    if (hasFederated) {
      if (hasLocal) throw badRequest("federatedIdentity is mutually exclusive with local playback identity fields.");
      if (!federatedIdentityValidator) throw Object.assign(new Error("Federated playback identity validation is unavailable."), { status: 404 });
      const value = request.federatedIdentity;
      if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some((key) => !["itemId", "sourceId"].includes(key))) {
        throw badRequest("federatedIdentity must contain only itemId and sourceId.");
      }
      const identity = {
        federatedItemId: requireOpaqueId(value.itemId, "federatedIdentity.itemId"),
        federatedSourceId: requireOpaqueId(value.sourceId, "federatedIdentity.sourceId"),
        kind: "federated"
      };
      if (!(await federatedIdentityValidator({ itemId: identity.federatedItemId, sourceId: identity.federatedSourceId }, principal))) {
        throw Object.assign(new Error("Media item was not found."), { status: 404 });
      }
      return identity;
    }
    if (request.itemId) return { itemId: requireUuid(request.itemId, "itemId"), kind: "local", sourceId: requireUuid(request.sourceId, "sourceId") };
    if (typeof request.contentPath !== "string" || !compatibilityResolver) {
      throw badRequest("itemId and sourceId are required.");
    }
    const resolved = await compatibilityResolver.resolveValidatedContentPath(request.contentPath, principal);
    if (!resolved) throw Object.assign(new Error("Media item was not found."), { status: 404 });
    return { itemId: requireUuid(resolved.itemId, "resolved itemId"), kind: "local", sourceId: requireUuid(resolved.sourceId, "resolved sourceId") };
  };

  const recordEvent = async (request, principal) => {
    const userId = requireUser(principal);
    if (!request || !EVENTS.has(request.event)) throw badRequest("event is invalid.");
    const eventId = requireUuid(request.eventId, "eventId");
    const identity = await resolveIdentity(request, principal);
    if (identity.kind === "local" && identityValidator && !(await identityValidator(identity, principal))) {
      throw Object.assign(new Error("Media item was not found."), { status: 404 });
    }
    const positionSeconds = Number(request.positionSeconds);
    const durationSeconds = request.durationSeconds == null ? null : Number(request.durationSeconds);
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0) throw badRequest("positionSeconds must be a finite non-negative number.");
    if (durationSeconds !== null && (!Number.isFinite(durationSeconds) || durationSeconds <= 0)) {
      throw badRequest("durationSeconds must be null or a finite positive number.");
    }
    if (durationSeconds !== null && positionSeconds > durationSeconds) throw badRequest("positionSeconds cannot exceed durationSeconds.");
    if (request.event === "complete" && durationSeconds === null) throw badRequest("Completion requires durationSeconds.");
    const completionProgress = durationSeconds === null ? 0 : positionSeconds / durationSeconds;
    if (request.event === "complete" && completionProgress < completionThreshold) {
      throw badRequest(`Completion requires at least ${Math.round(completionThreshold * 100)}% progress.`);
    }

    const timestamp = new Date(now()).toISOString();
    const sessionId = request.event === "start"
      ? (request.sessionId == null ? uuid() : requireUuid(request.sessionId, "sessionId"))
      : requireUuid(request.sessionId, "sessionId");
    const identityItemId = identity.kind === "federated" ? identity.federatedItemId : identity.itemId;
    const previous = identity.kind === "federated"
      ? repository.getFederatedState?.(userId, identityItemId)
      : repository.getState(userId, identityItemId);
    const elapsed = previous?.updatedAt ? now() - Date.parse(previous.updatedAt) : Infinity;
    const moved = previous ? Math.abs(positionSeconds - previous.positionSeconds) : Infinity;
    const applyProgress = request.event !== "progress" || elapsed >= progressIntervalMs || moved >= progressPositionDelta;
    const completed = request.event === "complete" || (request.event === "stop" && completionProgress >= completionThreshold);
    const record = identity.kind === "federated" ? repository.recordFederatedEvent : repository.recordEvent;
    if (typeof record !== "function") throw new TypeError("playbackRepository.recordFederatedEvent must be a function.");
    return record({
      ...identity, applyProgress, clientLabel: String(request.clientLabel ?? "Unknown client").trim().slice(0, 160) || "Unknown client",
      completed, durationSeconds, event: request.event, eventId, positionSeconds, recordedAt: timestamp, sessionId, userId
    });
  };

  const getState = (itemId, principal) => repository.getState(requireUser(principal), requireUuid(itemId, "itemId"));
  const getFederatedState = (identity, principal) => {
    const userId = requireUser(principal);
    if (!identity || typeof identity !== "object" || Array.isArray(identity)) throw badRequest("federatedIdentity is required.");
    if (typeof repository.getFederatedState !== "function") return null;
    return repository.getFederatedState(userId, requireOpaqueId(identity.itemId, "federatedIdentity.itemId"));
  };
  const getSession = (sessionId, principal) => {
    const userId = requireUser(principal);
    const session = repository.getSession(requireUuid(sessionId, "sessionId"));
    return session?.userId === userId ? session : null;
  };
  const compareEntries = (left, right) => {
    const recency = String(right.lastPlayedAt).localeCompare(String(left.lastPlayedAt));
    if (recency) return recency;
    const kind = String(left.identityKind).localeCompare(String(right.identityKind));
    return kind || String(left.itemId).localeCompare(String(right.itemId)) || String(left.sourceId).localeCompare(String(right.sourceId));
  };
  const visibleLocal = (entry, principal) => entry.identityKind === "federated" || !visibilityFilter || visibilityFilter(entry, principal);
  const combinedEntries = (kind, userId, principal) => {
    const local = kind === "history" ? (repository.listHistory ?? repository.listContinueWatching)(userId, null) : repository.listContinueWatching(userId, null);
    const federatedMethod = kind === "history" ? repository.listFederatedHistory : repository.listFederatedContinueWatching;
    const federated = typeof federatedMethod === "function" ? federatedMethod(userId, null) : [];
    return [...local, ...federated].filter((entry) => visibleLocal(entry, principal)).sort(compareEntries);
  };

  const listContinueWatching = ({ limit = 20 } = {}, principal) => {
    const userId = requireUser(principal);
    const numericLimit = Number(limit);
    if (!Number.isInteger(numericLimit) || numericLimit < 1 || numericLimit > 100) throw badRequest("limit must be an integer from 1 to 100.");
    return combinedEntries("continue", userId, principal).slice(0, numericLimit);
  };

  const listHistory = ({ limit = 50 } = {}, principal) => {
    const userId = requireUser(principal);
    const numericLimit = Number(limit);
    if (!Number.isInteger(numericLimit) || numericLimit < 1 || numericLimit > 100) throw badRequest("limit must be an integer from 1 to 100.");
    return combinedEntries("history", userId, principal).slice(0, numericLimit);
  };

  const setWatched = async (request, principal) => {
    const userId = requireUser(principal);
    if (typeof request?.watched !== "boolean") throw badRequest("watched must be a boolean.");
    const identity = await resolveIdentity(request, principal);
    if (identity.kind === "local" && identityValidator && !(await identityValidator(identity, principal))) {
      throw Object.assign(new Error("Media item was not found."), { status: 404 });
    }
    const setter = identity.kind === "federated" ? repository.setFederatedWatched : repository.setWatched;
    if (typeof setter !== "function") throw new TypeError("playbackRepository.setFederatedWatched must be a function.");
    return setter({ ...identity, userId, watched: request.watched, recordedAt: new Date(now()).toISOString() });
  };

  return { getFederatedState, getSession, getState, listContinueWatching, listHistory, recordEvent, setWatched };
};
