import { migratePlaybackSchema } from "./schema.mjs";

const TABLES = Object.freeze({
  federated: Object.freeze({ events: "federated_playback_events", item: "federated_item_id", sessions: "federated_playback_sessions", source: "federated_source_id", states: "federated_playback_states" }),
  local: Object.freeze({ events: "playback_events", item: "item_id", sessions: "playback_sessions", source: "source_id", states: "playback_states" })
});

const publicIdentity = (kind, itemId, sourceId) => kind === "federated"
  ? { federatedIdentity: { itemId, sourceId }, identityKind: kind, itemId, sourceId }
  : { identityKind: kind, itemId, sourceId };

const stateFromRow = (row, kind) => row ? ({
  completed: Boolean(row.completed),
  durationSeconds: row.duration_seconds,
  ...publicIdentity(kind, row[TABLES[kind].item], row[TABLES[kind].source]),
  lastPlayedAt: row.last_played_at,
  playCount: row.play_count,
  positionSeconds: row.position_seconds,
  updatedAt: row.updated_at,
  userId: row.user_id
}) : null;

const sessionFromRow = (row, kind) => row ? ({
  clientLabel: row.client_label,
  createdAt: row.created_at,
  id: row.id,
  ...publicIdentity(kind, row[TABLES[kind].item], row[TABLES[kind].source]),
  lastReportedAt: row.last_reported_at,
  state: row.state,
  userId: row.user_id
}) : null;

const historyFromRow = (row, kind) => ({
  completed: Boolean(row.completed),
  durationSeconds: row.duration_seconds,
  ...publicIdentity(kind, row[TABLES[kind].item], row[TABLES[kind].source]),
  lastPlayedAt: row.last_played_at,
  playCount: row.play_count,
  positionSeconds: row.position_seconds,
  progress: row.duration_seconds ? row.position_seconds / row.duration_seconds : 0
});

export const createPlaybackRepository = ({ db, migrate = false } = {}) => {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A SQLite database is required.");
  if (migrate) migratePlaybackSchema(db);

  const getStateFor = (kind, userId, itemId) => {
    const table = TABLES[kind];
    return stateFromRow(db.prepare(`SELECT * FROM ${table.states} WHERE user_id = ? AND ${table.item} = ?`).get(userId, itemId), kind);
  };
  const getSessionFor = (kind, sessionId) => sessionFromRow(
    db.prepare(`SELECT * FROM ${TABLES[kind].sessions} WHERE id = ?`).get(sessionId), kind
  );
  const getState = (userId, itemId) => getStateFor("local", userId, itemId);
  const getFederatedState = (userId, itemId) => getStateFor("federated", userId, itemId);
  const getSession = (sessionId) => getSessionFor("local", sessionId) ?? getSessionFor("federated", sessionId);

  const listFor = (kind, userId, limit, history) => {
    const table = TABLES[kind];
    const conditions = history
      ? "last_played_at IS NOT NULL"
      : "completed = 0 AND position_seconds > 0 AND duration_seconds IS NOT NULL AND position_seconds < duration_seconds";
    const sql = `SELECT * FROM ${table.states} WHERE user_id = ? AND ${conditions}
      ORDER BY last_played_at DESC, ${table.item} ASC${limit === null ? "" : " LIMIT ?"}`;
    return db.prepare(sql).all(...(limit === null ? [userId] : [userId, limit])).map((row) => {
      const entry = historyFromRow(row, kind);
      if (history) return entry;
      const { completed, durationSeconds, playCount, ...continuing } = entry;
      return continuing;
    });
  };
  const listContinueWatching = (userId, limit = 20) => listFor("local", userId, limit, false);
  const listFederatedContinueWatching = (userId, limit = 20) => listFor("federated", userId, limit, false);
  const listHistory = (userId, limit = 50) => listFor("local", userId, limit, true);
  const listFederatedHistory = (userId, limit = 50) => listFor("federated", userId, limit, true);

  const recordEventFor = (kind, event) => {
    const table = TABLES[kind];
    const otherKind = kind === "local" ? "federated" : "local";
    const other = TABLES[otherKind];
    const itemId = kind === "federated" ? event.federatedItemId : event.itemId;
    const sourceId = kind === "federated" ? event.federatedSourceId : event.sourceId;
    db.exec("BEGIN IMMEDIATE");
    try {
      const crossEvent = db.prepare(`SELECT 1 FROM ${other.events} WHERE user_id = ? AND event_id = ?`).get(event.userId, event.eventId);
      if (crossEvent) throw Object.assign(new Error("eventId was already used for a different playback event."), { status: 409 });
      const priorEvent = db.prepare(`SELECT * FROM ${table.events} WHERE user_id = ? AND event_id = ?`).get(event.userId, event.eventId);
      if (priorEvent) {
        const priorSession = getSessionFor(kind, priorEvent.session_id);
        const sameDuration = priorEvent.duration_seconds === event.durationSeconds;
        if (!priorSession || priorSession.itemId !== itemId || priorSession.sourceId !== sourceId
          || priorEvent.event_kind !== event.event || priorEvent.position_seconds !== event.positionSeconds || !sameDuration) {
          throw Object.assign(new Error("eventId was already used for a different playback event."), { status: 409 });
        }
        const result = { duplicate: true, session: priorSession, state: getStateFor(kind, event.userId, itemId) };
        db.exec("COMMIT");
        return result;
      }

      const existingSession = getSessionFor(kind, event.sessionId);
      const crossSession = getSessionFor(otherKind, event.sessionId);
      if (event.event === "start") {
        if (crossSession || (existingSession && (existingSession.userId !== event.userId || existingSession.itemId !== itemId))) {
          throw Object.assign(new Error("Playback session does not belong to this user and item."), { status: 404 });
        }
        if (!existingSession) db.prepare(`INSERT INTO ${table.sessions}
          (id, user_id, ${table.item}, ${table.source}, client_label, state, created_at, last_reported_at)
          VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`)
          .run(event.sessionId, event.userId, itemId, sourceId, event.clientLabel, event.recordedAt, event.recordedAt);
      } else if (!existingSession || existingSession.userId !== event.userId || existingSession.itemId !== itemId || existingSession.sourceId !== sourceId) {
        throw Object.assign(new Error("Playback session was not found."), { status: 404 });
      } else if (["stopped", "completed"].includes(existingSession.state)) {
        throw Object.assign(new Error("Playback session has already ended."), { status: 409 });
      }

      const previous = getStateFor(kind, event.userId, itemId);
      const applied = event.applyProgress || event.event !== "progress";
      const completed = event.completed;
      if (applied) {
        const playCount = (previous?.playCount ?? 0) + (completed && !previous?.completed ? 1 : 0);
        const position = completed ? 0 : event.positionSeconds;
        db.prepare(`INSERT INTO ${table.states}
          (user_id, ${table.item}, ${table.source}, position_seconds, duration_seconds, completed, play_count, last_played_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, ${table.item}) DO UPDATE SET
            ${table.source}=excluded.${table.source}, position_seconds=excluded.position_seconds,
            duration_seconds=COALESCE(excluded.duration_seconds, ${table.states}.duration_seconds),
            completed=excluded.completed, play_count=excluded.play_count,
            last_played_at=excluded.last_played_at, updated_at=excluded.updated_at`)
          .run(event.userId, itemId, sourceId, position, event.durationSeconds,
            completed ? 1 : 0, playCount, event.recordedAt, event.recordedAt);
      }

      const sessionState = event.event === "complete" ? "completed" : event.event === "pause" ? "paused"
        : event.event === "stop" ? "stopped" : "active";
      db.prepare(`UPDATE ${table.sessions} SET state = ?, last_reported_at = ?, ended_at = ? WHERE id = ?`)
        .run(sessionState, event.recordedAt, ["stopped", "completed"].includes(sessionState) ? event.recordedAt : null, event.sessionId);
      db.prepare(`INSERT INTO ${table.events}
        (user_id, event_id, session_id, event_kind, position_seconds, duration_seconds, recorded_at, applied)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(event.userId, event.eventId, event.sessionId, event.event, event.positionSeconds,
          event.durationSeconds, event.recordedAt, applied ? 1 : 0);
      const result = { duplicate: false, session: getSessionFor(kind, event.sessionId), state: getStateFor(kind, event.userId, itemId) };
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const recordEvent = (event) => recordEventFor("local", event);
  const recordFederatedEvent = (event) => recordEventFor("federated", event);

  const setWatchedFor = (kind, event) => {
    const table = TABLES[kind];
    const itemId = kind === "federated" ? event.federatedItemId : event.itemId;
    const sourceId = kind === "federated" ? event.federatedSourceId : event.sourceId;
    const previous = getStateFor(kind, event.userId, itemId);
    const playCount = (previous?.playCount ?? 0) + (event.watched && !previous?.completed ? 1 : 0);
    db.prepare(`INSERT INTO ${table.states}
      (user_id, ${table.item}, ${table.source}, position_seconds, duration_seconds, completed, play_count, last_played_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, ${table.item}) DO UPDATE SET ${table.source}=excluded.${table.source}, position_seconds=0,
        completed=excluded.completed, play_count=excluded.play_count,
        last_played_at=excluded.last_played_at, updated_at=excluded.updated_at`)
      .run(event.userId, itemId, sourceId, previous?.durationSeconds ?? null, event.watched ? 1 : 0, playCount, event.recordedAt, event.recordedAt);
    return getStateFor(kind, event.userId, itemId);
  };
  const setWatched = (event) => setWatchedFor("local", event);
  const setFederatedWatched = (event) => setWatchedFor("federated", event);

  return {
    getFederatedState, getSession, getState, listContinueWatching, listFederatedContinueWatching,
    listFederatedHistory, listHistory, recordEvent, recordFederatedEvent, setFederatedWatched, setWatched
  };
};
