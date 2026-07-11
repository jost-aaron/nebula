import { randomUUID } from "node:crypto";
import { PLAYBACK_REPOSITORY_METHODS, requireMediaContract } from "../mediaContracts.mjs";

const EVENTS = new Set(["start", "progress", "pause", "stop", "complete"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const requireUuid = (value, label) => {
  if (typeof value !== "string" || !UUID.test(value)) throw badRequest(`${label} must be a UUID.`);
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
  now = () => Date.now(),
  progressIntervalMs = 10_000,
  progressPositionDelta = 10,
  repository,
  uuid = randomUUID
} = {}) => {
  requireMediaContract("playbackRepository", repository, PLAYBACK_REPOSITORY_METHODS);
  if (compatibilityResolver && typeof compatibilityResolver.resolveValidatedContentPath !== "function") {
    throw new TypeError("compatibilityResolver.resolveValidatedContentPath must be a function.");
  }

  const resolveIdentity = async (request, principal) => {
    if (request.itemId) return { itemId: requireUuid(request.itemId, "itemId"), sourceId: requireUuid(request.sourceId, "sourceId") };
    if (typeof request.contentPath !== "string" || !compatibilityResolver) {
      throw badRequest("itemId and sourceId are required.");
    }
    const resolved = await compatibilityResolver.resolveValidatedContentPath(request.contentPath, principal);
    if (!resolved) throw Object.assign(new Error("Media item was not found."), { status: 404 });
    return { itemId: requireUuid(resolved.itemId, "resolved itemId"), sourceId: requireUuid(resolved.sourceId, "resolved sourceId") };
  };

  const recordEvent = async (request, principal) => {
    const userId = requireUser(principal);
    if (!request || !EVENTS.has(request.event)) throw badRequest("event is invalid.");
    const eventId = requireUuid(request.eventId, "eventId");
    const identity = await resolveIdentity(request, principal);
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
    const previous = repository.getState(userId, identity.itemId);
    const elapsed = previous?.updatedAt ? now() - Date.parse(previous.updatedAt) : Infinity;
    const moved = previous ? Math.abs(positionSeconds - previous.positionSeconds) : Infinity;
    const applyProgress = request.event !== "progress" || elapsed >= progressIntervalMs || moved >= progressPositionDelta;
    const completed = request.event === "complete" || (request.event === "stop" && completionProgress >= completionThreshold);
    return repository.recordEvent({
      ...identity, applyProgress, clientLabel: String(request.clientLabel ?? "Unknown client").trim().slice(0, 160) || "Unknown client",
      completed, durationSeconds, event: request.event, eventId, positionSeconds, recordedAt: timestamp, sessionId, userId
    });
  };

  const getState = (itemId, principal) => repository.getState(requireUser(principal), requireUuid(itemId, "itemId"));
  const getSession = (sessionId, principal) => {
    const userId = requireUser(principal);
    const session = repository.getSession(requireUuid(sessionId, "sessionId"));
    return session?.userId === userId ? session : null;
  };
  const listContinueWatching = ({ limit = 20 } = {}, principal) => {
    const userId = requireUser(principal);
    const numericLimit = Number(limit);
    if (!Number.isInteger(numericLimit) || numericLimit < 1 || numericLimit > 100) throw badRequest("limit must be an integer from 1 to 100.");
    return repository.listContinueWatching(userId, numericLimit);
  };

  return { getSession, getState, listContinueWatching, recordEvent };
};
