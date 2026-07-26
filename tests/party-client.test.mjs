import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const api = await readFile(new URL("../src/api/partyApi.ts", import.meta.url), "utf8");
const view = await readFile(new URL("../src/party/renderPartyView.ts", import.meta.url), "utf8");

test("Party API client covers the bounded server route contract", () => {
  for (const route of [
    'partyPath("/users")',
    'partyPath("/conversations")',
    'partyPath("/direct")',
    'partyPath("/groups")',
    'conversationPath(conversationId, "/members")',
    'conversationPath(conversationId, "/messages")',
    'conversationPath(conversationId, "/read")',
    'partyPath("/events")'
  ]) assert.ok(api.includes(route), `missing ${route}`);
  assert.match(api, /beforeSequence: options\.beforeSequence/);
  assert.match(api, /limit: options\.limit \?\? 50/);
  assert.match(api, /encodeURIComponent\(conversationId\)/);
  assert.match(api, /encodeURIComponent\(userId\)/);
});

test("attachment transport is authenticated raw XHR with progress and cancellation", () => {
  assert.match(api, /new XMLHttpRequest\(\)/);
  assert.match(api, /request\.upload\.addEventListener\("progress"/);
  assert.match(api, /applyApiHeadersToRequest\(request/);
  assert.match(api, /"x-nebula-file-name": encodeURIComponent\(file\.name\)/);
  assert.match(api, /"content-type": file\.type \|\| "application\/octet-stream"/);
  assert.match(api, /request\.send\(file\)/);
  assert.match(api, /cancel: \(\) => request\.abort\(\)/);
  assert.match(api, /apiFetch\(withQuery\(partyPath\(`\/attachments\//);
  assert.match(api, /download: download \? 1 : undefined/);
});

test("authenticated fetch-stream SSE parses bounded hints without message content", () => {
  assert.match(api, /headers: apiHeaders\(\{ accept: "text\/event-stream" \}\)/);
  assert.match(api, /credentials: "include"/);
  assert.match(api, /response\.body\.getReader\(\)/);
  assert.match(api, /pending\.split\(\/\\r\?\\n\\r\?\\n\//);
  assert.match(api, /eventType !== "ready" && eventType !== "conversation"/);
  const decoder = api.slice(api.indexOf("const decodeSseFrame"), api.indexOf("export const streamPartyEvents"));
  assert.doesNotMatch(decoder, /message\.text|attachments|displayName|mimeType/);
});

test("Party reconnects with capped backoff and resynchronizes after hints and browser recovery", () => {
  assert.match(view, /Math\.min\(30_000, 1_000 \* \(2 \*\* reconnectAttempt\)\)/);
  assert.match(view, /window\.addEventListener\("offline"/);
  assert.match(view, /window\.addEventListener\("online"/);
  assert.match(view, /window\.addEventListener\("focus"/);
  assert.match(view, /onEvent: \(event\) => resync\(event\.conversationId\)/);
  assert.match(view, /setConnection\("reconnecting"\)/);
  assert.match(view, /setConnection\("connected"\)/);
  assert.match(view, /setConnection\("offline"\)/);
});

test("message mutations use unique idempotency keys and per-user read positions", () => {
  assert.match(view, /sendPartyMessage\(selectedConversation\.id, text, clientId\(\)\)/);
  assert.match(view, /uploadPartyAttachment\(conversationId, upload\.file, clientId\(\)/);
  assert.match(view, /markPartyConversationRead\(conversationId, sequence\)/);
  assert.match(api, /body: JSON\.stringify\(\{ clientId, text \}\)/);
  assert.match(api, /body: JSON\.stringify\(\{ sequence \}\)/);
});
