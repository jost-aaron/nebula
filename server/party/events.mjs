const SSE_HEADERS = Object.freeze({
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "content-type": "text/event-stream; charset=utf-8",
  "x-accel-buffering": "no"
});

export const createPartyEvents = ({
  heartbeatMs = 25_000,
  isIdentityActive = () => true,
  isConversationMember,
  maxConnections = 256,
  maxConnectionsPerUser = 4,
  revalidateMs = 15_000
} = {}) => {
  if (typeof isConversationMember !== "function") {
    throw new TypeError("isConversationMember must be provided.");
  }
  if (typeof isIdentityActive !== "function") {
    throw new TypeError("isIdentityActive must be a function.");
  }
  const subscribers = new Map();
  let nextId = 1;

  const remove = (id, { end = false } = {}) => {
    const subscriber = subscribers.get(id);
    if (!subscriber) return;
    clearInterval(subscriber.heartbeat);
    subscribers.delete(id);
    if (end) {
      try { subscriber.response.end(); } catch {}
    }
  };

  const identityFrom = (identity) => {
    if (typeof identity === "string") return { expiresAt: null, sessionId: null, userId: identity };
    if (
      identity?.kind !== "account"
      || !identity.sessionId
      || !identity.user?.id
      || identity.user.disabled
    ) {
      throw Object.assign(new Error("An active account session is required for Party events."), {
        code: "party_event_session_required",
        expose: true,
        status: 401
      });
    }
    return {
      expiresAt: identity.expiresAt ?? null,
      sessionId: identity.sessionId,
      userId: identity.user.id
    };
  };

  const subscriberIsActive = (subscriber, now = Date.now(), { force = false } = {}) => {
    if (subscriber.expiresAt && Date.parse(subscriber.expiresAt) <= now) return false;
    if (!force && now - subscriber.lastValidatedAt < Math.max(1_000, revalidateMs)) return true;
    const active = isIdentityActive({
      expiresAt: subscriber.expiresAt,
      sessionId: subscriber.sessionId,
      userId: subscriber.userId
    });
    subscriber.lastValidatedAt = now;
    return active === true;
  };

  const subscribe = (request, response, identity) => {
    const { expiresAt, sessionId, userId } = identityFrom(identity);
    if (
      (expiresAt && Date.parse(expiresAt) <= Date.now())
      || !isIdentityActive({ expiresAt, sessionId, userId })
    ) {
      throw Object.assign(new Error("The Party event session is no longer active."), {
        code: "party_event_session_inactive",
        expose: true,
        status: 401
      });
    }
    const forUser = [...subscribers.values()].filter((item) => item.userId === userId).length;
    if (subscribers.size >= maxConnections || forUser >= maxConnectionsPerUser) {
      throw Object.assign(new Error("Too many Party event connections."), {
        code: "party_event_limit", expose: true, status: 429
      });
    }
    const id = nextId++;
    response.writeHead(200, SSE_HEADERS);
    response.write("retry: 2000\nevent: ready\ndata: {}\n\n");
    const heartbeat = setInterval(() => {
      try {
        const subscriber = subscribers.get(id);
        if (!subscriber || !subscriberIsActive(subscriber)) {
          remove(id, { end: true });
          return;
        }
        if (!response.write(`: heartbeat ${Date.now()}\n\n`)) {
          remove(id, { end: true });
        }
      } catch {
        remove(id, { end: true });
      }
    }, Math.max(5_000, heartbeatMs));
    heartbeat.unref?.();
    subscribers.set(id, {
      expiresAt,
      heartbeat,
      lastValidatedAt: Date.now(),
      response,
      sessionId,
      userId
    });
    const close = () => remove(id);
    request.once("close", close);
    response.once("close", close);
    return true;
  };

  const publish = (conversationId) => {
    const payload = `event: conversation\ndata: ${JSON.stringify({ conversationId })}\n\n`;
    for (const [id, subscriber] of subscribers) {
      try {
        if (!subscriberIsActive(subscriber, Date.now(), { force: true })) {
          remove(id, { end: true });
        } else if (isConversationMember({ conversationId, userId: subscriber.userId })) {
          if (!subscriber.response.write(payload)) {
            remove(id, { end: true });
          }
        }
      } catch {
        remove(id, { end: true });
      }
    }
  };

  const closeMatching = (predicate) => {
    for (const [id, subscriber] of subscribers) {
      if (predicate(subscriber)) remove(id, { end: true });
    }
  };
  const closeSession = (sessionId) => closeMatching((subscriber) => subscriber.sessionId === sessionId);
  const closeUser = (userId) => closeMatching((subscriber) => subscriber.userId === userId);

  const close = () => {
    for (const [id, subscriber] of subscribers) {
      remove(id, { end: true });
    }
  };

  return {
    close,
    closeSession,
    closeUser,
    publish,
    subscribe,
    subscriberCount: () => subscribers.size
  };
};
