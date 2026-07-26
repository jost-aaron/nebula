const SSE_HEADERS = Object.freeze({
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "content-type": "text/event-stream; charset=utf-8",
  "x-accel-buffering": "no"
});

export const createPartyEvents = ({
  heartbeatMs = 25_000,
  isConversationMember,
  maxConnections = 256,
  maxConnectionsPerUser = 4
} = {}) => {
  if (typeof isConversationMember !== "function") {
    throw new TypeError("isConversationMember must be provided.");
  }
  const subscribers = new Map();
  let nextId = 1;

  const remove = (id) => {
    const subscriber = subscribers.get(id);
    if (!subscriber) return;
    clearInterval(subscriber.heartbeat);
    subscribers.delete(id);
  };

  const subscribe = (request, response, userId) => {
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
        if (!response.write(`: heartbeat ${Date.now()}\n\n`)) {
          remove(id);
          response.end();
        }
      } catch {
        remove(id);
      }
    }, Math.max(5_000, heartbeatMs));
    heartbeat.unref?.();
    subscribers.set(id, { heartbeat, response, userId });
    const close = () => remove(id);
    request.once("close", close);
    response.once("close", close);
    return true;
  };

  const publish = (conversationId) => {
    const payload = `event: conversation\ndata: ${JSON.stringify({ conversationId })}\n\n`;
    for (const [id, subscriber] of subscribers) {
      try {
        if (isConversationMember({ conversationId, userId: subscriber.userId })) {
          if (!subscriber.response.write(payload)) {
            remove(id);
            subscriber.response.end();
          }
        }
      } catch {
        remove(id);
      }
    }
  };

  const close = () => {
    for (const [id, subscriber] of subscribers) {
      try { subscriber.response.end(); } catch {}
      remove(id);
    }
  };

  return { close, publish, subscribe, subscriberCount: () => subscribers.size };
};
