import { migratePlaybackSchema } from "./schema.mjs";

const stateFromRow = (row) => row ? ({
  completed: Boolean(row.completed),
  durationSeconds: row.duration_seconds,
  itemId: row.item_id,
  lastPlayedAt: row.last_played_at,
  playCount: row.play_count,
  positionSeconds: row.position_seconds,
  sourceId: row.source_id,
  updatedAt: row.updated_at,
  userId: row.user_id
}) : null;

const sessionFromRow = (row) => row ? ({
  clientLabel: row.client_label,
  createdAt: row.created_at,
  id: row.id,
  itemId: row.item_id,
  lastReportedAt: row.last_reported_at,
  sourceId: row.source_id,
  state: row.state,
  userId: row.user_id
}) : null;

export const createPlaybackRepository = ({ db, migrate = false } = {}) => {
  if (!db || typeof db.prepare !== "function") throw new TypeError("A SQLite database is required.");
  if (migrate) migratePlaybackSchema(db);

  const getState = (userId, itemId) => stateFromRow(
    db.prepare("SELECT * FROM playback_states WHERE user_id = ? AND item_id = ?").get(userId, itemId)
  );

  const getSession = (sessionId) => sessionFromRow(
    db.prepare("SELECT * FROM playback_sessions WHERE id = ?").get(sessionId)
  );

  const continueWatchingSql = `
    SELECT * FROM playback_states
    WHERE user_id = ? AND completed = 0 AND position_seconds > 0
      AND duration_seconds IS NOT NULL AND position_seconds < duration_seconds
    ORDER BY last_played_at DESC, item_id ASC`;

  const listContinueWatching = (userId, limit = 20) => db.prepare(
    limit === null ? continueWatchingSql : `${continueWatchingSql} LIMIT ?`
  ).all(...(limit === null ? [userId] : [userId, limit])).map((row) => ({
    itemId: row.item_id,
    lastPlayedAt: row.last_played_at,
    positionSeconds: row.position_seconds,
    progress: row.position_seconds / row.duration_seconds,
    sourceId: row.source_id
  }));

  const historySql = `
    SELECT * FROM playback_states
    WHERE user_id = ? AND last_played_at IS NOT NULL
    ORDER BY last_played_at DESC, item_id ASC`;

  const listHistory = (userId, limit = 50) => db.prepare(
    limit === null ? historySql : `${historySql} LIMIT ?`
  ).all(...(limit === null ? [userId] : [userId, limit])).map((row) => ({
    completed: Boolean(row.completed),
    durationSeconds: row.duration_seconds,
    itemId: row.item_id,
    lastPlayedAt: row.last_played_at,
    playCount: row.play_count,
    positionSeconds: row.position_seconds,
    progress: row.duration_seconds ? row.position_seconds / row.duration_seconds : 0,
    sourceId: row.source_id
  }));

  const recordEvent = (event) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const priorEvent = db.prepare(
        "SELECT * FROM playback_events WHERE user_id = ? AND event_id = ?"
      ).get(event.userId, event.eventId);
      if (priorEvent) {
        const priorSession = getSession(priorEvent.session_id);
        const sameDuration = priorEvent.duration_seconds === event.durationSeconds;
        if (!priorSession || priorSession.itemId !== event.itemId || priorSession.sourceId !== event.sourceId
          || priorEvent.event_kind !== event.event || priorEvent.position_seconds !== event.positionSeconds || !sameDuration) {
          throw Object.assign(new Error("eventId was already used for a different playback event."), { status: 409 });
        }
        const result = { duplicate: true, session: priorSession, state: getState(event.userId, priorSession.itemId) };
        db.exec("COMMIT");
        return result;
      }

      const existingSession = getSession(event.sessionId);
      if (event.event === "start") {
        if (existingSession && (existingSession.userId !== event.userId || existingSession.itemId !== event.itemId)) {
          throw Object.assign(new Error("Playback session does not belong to this user and item."), { status: 404 });
        }
        if (!existingSession) db.prepare(`
          INSERT INTO playback_sessions
            (id, user_id, item_id, source_id, client_label, state, created_at, last_reported_at)
          VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
        `).run(event.sessionId, event.userId, event.itemId, event.sourceId, event.clientLabel, event.recordedAt, event.recordedAt);
      } else if (!existingSession || existingSession.userId !== event.userId || existingSession.itemId !== event.itemId) {
        throw Object.assign(new Error("Playback session was not found."), { status: 404 });
      } else if (["stopped", "completed"].includes(existingSession.state)) {
        throw Object.assign(new Error("Playback session has already ended."), { status: 409 });
      }

      const previous = getState(event.userId, event.itemId);
      const applied = event.applyProgress || event.event !== "progress";
      const completed = event.completed;
      if (applied) {
        const playCount = (previous?.playCount ?? 0) + (completed && !previous?.completed ? 1 : 0);
        const position = completed ? 0 : event.positionSeconds;
        db.prepare(`
          INSERT INTO playback_states
            (user_id, item_id, source_id, position_seconds, duration_seconds, completed, play_count, last_played_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, item_id) DO UPDATE SET
            source_id=excluded.source_id, position_seconds=excluded.position_seconds,
            duration_seconds=COALESCE(excluded.duration_seconds, playback_states.duration_seconds),
            completed=excluded.completed, play_count=excluded.play_count,
            last_played_at=excluded.last_played_at, updated_at=excluded.updated_at
        `).run(event.userId, event.itemId, event.sourceId, position, event.durationSeconds,
          completed ? 1 : 0, playCount, event.recordedAt, event.recordedAt);
      }

      const sessionState = event.event === "complete" ? "completed" : event.event === "pause" ? "paused"
        : event.event === "stop" ? "stopped" : "active";
      db.prepare(`UPDATE playback_sessions SET state = ?, last_reported_at = ?, ended_at = ? WHERE id = ?`)
        .run(sessionState, event.recordedAt, ["stopped", "completed"].includes(sessionState) ? event.recordedAt : null, event.sessionId);
      db.prepare(`INSERT INTO playback_events
        (user_id, event_id, session_id, event_kind, position_seconds, duration_seconds, recorded_at, applied)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(event.userId, event.eventId, event.sessionId, event.event, event.positionSeconds,
          event.durationSeconds, event.recordedAt, applied ? 1 : 0);
      const result = { duplicate: false, session: getSession(event.sessionId), state: getState(event.userId, event.itemId) };
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const setWatched = ({ itemId, sourceId, userId, watched, recordedAt }) => {
    const previous = getState(userId, itemId);
    const playCount = (previous?.playCount ?? 0) + (watched && !previous?.completed ? 1 : 0);
    db.prepare(`INSERT INTO playback_states
      (user_id, item_id, source_id, position_seconds, duration_seconds, completed, play_count, last_played_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, item_id) DO UPDATE SET source_id=excluded.source_id, position_seconds=0,
        completed=excluded.completed, play_count=excluded.play_count,
        last_played_at=excluded.last_played_at, updated_at=excluded.updated_at`)
      .run(userId, itemId, sourceId, previous?.durationSeconds ?? null, watched ? 1 : 0, playCount, recordedAt, recordedAt);
    return getState(userId, itemId);
  };

  return { getSession, getState, listContinueWatching, listHistory, recordEvent, setWatched };
};
