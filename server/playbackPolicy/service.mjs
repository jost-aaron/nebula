const denial = (status, code, message) => Object.assign(new Error(message), { status, code, expose: true });
const finiteMin = (...values) => {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length ? Math.min(...finite) : null;
};
const validatePolicy = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw denial(400, "invalid_playback_policy", "Playback policy must be an object.");
  const maxConcurrentStreams = value.maxConcurrentStreams ?? null;
  const maxBitrate = value.maxBitrate ?? null;
  if (maxConcurrentStreams !== null && (!Number.isInteger(maxConcurrentStreams) || maxConcurrentStreams < 1 || maxConcurrentStreams > 100)) {
    throw denial(400, "invalid_stream_limit", "Concurrent stream limit must be null or an integer from 1 to 100.");
  }
  if (maxBitrate !== null && (!Number.isInteger(maxBitrate) || maxBitrate < 64_000 || maxBitrate > 1_000_000_000)) {
    throw denial(400, "invalid_bitrate_limit", "Bitrate limit must be null or an integer from 64,000 to 1,000,000,000 bits per second.");
  }
  return { maxBitrate, maxConcurrentStreams };
};

export const createPlaybackPolicyService = ({ repository }) => {
  const leases = new Map();
  let closed = false;
  const counts = () => {
    const users = new Map();
    for (const lease of leases.values()) users.set(lease.userId, (users.get(lease.userId) ?? 0) + 1);
    return users;
  };
  const effectiveFor = (userId) => {
    const global = repository.getGlobal();
    const override = repository.getUser(userId);
    return {
      global,
      override,
      effective: {
        maxBitrate: finiteMin(global.maxBitrate, override?.maxBitrate),
        maxConcurrentStreams: override?.maxConcurrentStreams ?? null
      }
    };
  };
  const enforce = ({ decision, fixedProfile = false, producedBitrate, requestedBitrate, strictProducedBitrate = false, userId }, { existing = false } = {}) => {
    const { effective, global } = effectiveFor(userId);
    const byUser = counts();
    const globalDenied = global.maxConcurrentStreams !== null
      && (existing ? leases.size > global.maxConcurrentStreams : leases.size >= global.maxConcurrentStreams);
    if (globalDenied) {
      throw denial(429, "global_stream_limit_reached", "The server concurrent stream limit has been reached.");
    }
    const userStreams = byUser.get(userId) ?? 0;
    const userDenied = effective.maxConcurrentStreams !== null
      && (existing ? userStreams > effective.maxConcurrentStreams : userStreams >= effective.maxConcurrentStreams);
    if (userDenied) {
      throw denial(429, "user_stream_limit_reached", "Your concurrent stream limit has been reached.");
    }
    if (effective.maxBitrate !== null && Number.isFinite(requestedBitrate) && requestedBitrate > effective.maxBitrate) {
      throw denial(422, "bitrate_limit_exceeded", "The requested bitrate exceeds the configured playback limit.");
    }
    if (decision === "remux" && effective.maxBitrate !== null && Number.isFinite(producedBitrate) && producedBitrate > effective.maxBitrate) {
      throw denial(422, "produced_bitrate_limit_exceeded", "The remux output bitrate exceeds the configured playback limit.");
    }
    if (decision === "transcode" && fixedProfile && effective.maxBitrate !== null && Number.isFinite(producedBitrate) && producedBitrate > effective.maxBitrate) {
      throw denial(422, "rendition_bitrate_limit_exceeded", "The rendition profile exceeds the configured playback limit.");
    }
    if (decision === "transcode" && strictProducedBitrate && effective.maxBitrate !== null
      && Number.isFinite(producedBitrate) && producedBitrate > effective.maxBitrate) {
      throw denial(422, "produced_bitrate_limit_exceeded", "The produced bitrate exceeds the configured playback limit.");
    }
    return effective;
  };
  const admit = ({ decision, fixedProfile = false, producedBitrate, requestedBitrate, sessionId, strictProducedBitrate = false, userId }) => {
    if (closed) throw denial(503, "playback_policy_closed", "Playback policy admission is shutting down.");
    if (decision === "direct-play") return { maxProducedBitrate: null, release() {} };
    if (!sessionId || leases.has(sessionId)) throw denial(409, "playback_policy_collision", "A unique playback policy lease could not be allocated.");
    const effective = enforce({ decision, fixedProfile, producedBitrate, requestedBitrate, strictProducedBitrate, userId });
    const lease = { decision, sessionId, startedAt: new Date().toISOString(), userId };
    leases.set(sessionId, lease);
    let released = false;
    return {
      maxProducedBitrate: effective.maxBitrate,
      release() {
        if (released) return;
        released = true;
        leases.delete(sessionId);
      }
    };
  };
  const status = () => {
    const byUser = counts();
    const users = repository.listUsers().map((user) => ({
      activeStreams: byUser.get(user.id) ?? 0,
      disabled: user.disabled,
      displayName: user.displayName,
      effective: effectiveFor(user.id).effective,
      id: user.id,
      override: user.policy,
      username: user.username
    }));
    return { activeStreams: leases.size, global: repository.getGlobal(), users };
  };
  return {
    admit,
    constraints: (userId) => ({ ...effectiveFor(userId).effective }),
    getConfig: () => ({ global: repository.getGlobal(), users: status().users }),
    setGlobal: (policy) => repository.setGlobal(validatePolicy(policy)),
    setUser: (userId, policy) => {
      const saved = repository.setUser(userId, validatePolicy(policy));
      if (!saved) throw denial(404, "user_not_found", "Account not found.");
      return saved;
    },
    validate({ decision, fixedProfile = false, producedBitrate, requestedBitrate, sessionId, strictProducedBitrate = false, userId }) {
      if (closed) throw denial(503, "playback_policy_closed", "Playback policy admission is shutting down.");
      const lease = leases.get(sessionId);
      if (!lease || lease.userId !== userId || lease.decision !== decision) {
        throw denial(409, "playback_policy_lease_invalid", "The playback policy lease is no longer valid.");
      }
      const effective = enforce({ decision, fixedProfile, producedBitrate, requestedBitrate, strictProducedBitrate, userId }, { existing: true });
      return { maxProducedBitrate: effective.maxBitrate };
    },
    shutdown() { closed = true; leases.clear(); },
    status
  };
};
