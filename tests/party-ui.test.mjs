import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (file) => readFile(new URL(file, import.meta.url), "utf8");
const [view, css, types, main] = await Promise.all([
  read("../src/party/renderPartyView.ts"),
  read("../src/party/party.css"),
  read("../src/shared/partyTypes.ts"),
  read("../src/main.ts")
]);

test("Party exposes a lifecycle-owned lazy application surface", () => {
  assert.match(view, /import "\.\/party\.css"/);
  assert.match(view, /export const renderPartyView/);
  assert.match(view, /export const bindPartyView/);
  assert.match(view, /return \(\) => \{/);
  assert.match(view, /viewController\.abort\(\)/);
  assert.match(view, /eventController\?\.abort\(\)/);
  assert.match(view, /uploads\.forEach\(\(upload\) => upload\.handle\?\.cancel\(\)\)/);
  assert.match(view, /URL\.revokeObjectURL/);
  assert.match(main, /import\("\.\/party\/renderPartyView"\)/);
  assert.doesNotMatch(main, /from "\.\/party\/renderPartyView"/);
  assert.match(main, /disposeActiveApp = partyModule\.bindPartyView/);
  assert.match(main, /currentUserId: accountSession\.user\.id/);
});

test("Party renders safe conversation, unread, message, and pagination contracts", () => {
  assert.match(view, /escapeHtml\(conversation\.id\)/);
  assert.match(view, /escapeHtml\(message\.text\)/);
  assert.match(view, /conversation\.unreadCount > 0/);
  assert.match(view, /messagePreview\(conversation\.lastMessage\)/);
  assert.match(view, /data-party-more-conversations/);
  assert.match(view, /data-party-older/);
  assert.match(view, /messages = \[\.\.\.byId\.values\(\)\]\.sort\(\(a, b\) => a\.sequence - b\.sequence\)/);
  assert.match(css, /white-space: pre-wrap/);
  assert.doesNotMatch(view, /innerHTML\s*=\s*message\.text/);
});

test("Party includes account discovery, canonical direct, and managed group flows", () => {
  for (const hook of [
    "data-party-user-search",
    "data-party-new-mode",
    "data-party-create-group",
    "data-party-members",
    "data-party-group-details",
    "data-party-member-role",
    "data-party-remove-member",
    "data-party-avatar"
  ]) assert.match(view, new RegExp(hook));
  assert.match(view, /createPartyDirectConversation\(userId\)/);
  assert.match(view, /createPartyGroupConversation\(\{ memberIds: \[\.\.\.selectedUserIds\], title \}\)/);
  assert.match(view, /updatePartyConversationMember/);
  assert.match(view, /current\?\.role === "owner" \|\| current\?\.role === "admin"/);
});

test("Party composer and uploads expose keyboard, progress, cancel, retry, and preview states", () => {
  assert.match(view, /event\.key === "Enter" && !event\.shiftKey && !event\.isComposing/);
  assert.match(view, /maxlength="8000"/);
  assert.match(view, /data-party-cancel-upload/);
  assert.match(view, /data-party-retry-upload/);
  assert.match(view, /Files must be 25 MB or smaller/);
  assert.match(view, /uploadPartyAttachment\(conversationId, upload\.file, clientId\(\)/);
  for (const media of ["image", "video", "audio", "file"]) {
    assert.match(view, new RegExp(`"${media}"`));
  }
  assert.match(view, /fetchPartyAttachment\(id, controller\.signal\)/);
  assert.match(view, /downloadPartyAttachment/);
});

test("Party has responsive, accessible controller-friendly presentation", () => {
  assert.match(view, /aria-live="polite"/);
  assert.match(view, /role="dialog" aria-modal="true"/);
  assert.match(view, /aria-current=/);
  assert.match(view, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  assert.match(view, /event\.key\.toLowerCase\(\) === "k"/);
  assert.match(css, /grid-template-columns: minmax\(270px, 350px\) minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /\.party-app\.is-mobile-thread \.party-thread/);
  assert.match(css, /--safe-area-(top|right|bottom|left)/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("Party clears the conversation loading state before rendering empty or error results", () => {
  assert.match(view, /loadingConversations = false;\s+renderConversationList\(\);/);
  assert.doesNotMatch(view, /renderConversationList\(\);\s*}\s*finally\s*{[^}]*loadingConversations = false/s);
});

test("Party shared contracts keep stable IDs, roles, cursors, and attachment metadata typed", () => {
  assert.match(types, /type PartyMemberRole = "owner" \| "admin" \| "member"/);
  assert.match(types, /interface PartyConversation/);
  assert.match(types, /unreadCount: number/);
  assert.match(types, /nextCursor: number \| null/);
  assert.match(types, /interface PartyAttachment/);
  assert.match(types, /mimeType: string/);
  assert.match(types, /uploaderId: string/);
  assert.match(types, /interface PartyExportPage/);
});
