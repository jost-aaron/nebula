export type PartyConversationKind = "direct" | "group";
export type PartyMemberRole = "owner" | "admin" | "member";

export interface PartyUser {
  displayName: string;
  id: string;
  username: string;
}

export interface PartyMember extends PartyUser {
  role: PartyMemberRole;
}

export interface PartyAttachment {
  createdAt: string;
  displayName: string;
  id: string;
  mimeType: string;
  size: number;
  uploaderId: string;
}

export interface PartyMessage {
  attachments: PartyAttachment[];
  conversationId: string;
  createdAt: string;
  id: string;
  senderId: string;
  sequence: number;
  text: string;
}

export interface PartyConversation {
  avatarAttachmentId: string | null;
  createdAt: string;
  id: string;
  kind: PartyConversationKind;
  lastMessage: PartyMessage | null;
  memberCount: number;
  members?: PartyMember[];
  title: string | null;
  unreadCount: number;
  updatedAt: string;
}

export interface PartyConversationList {
  conversations: PartyConversation[];
  nextCursor: string | null;
}

export interface PartyMessagePage {
  messages: PartyMessage[];
  nextCursor: number | null;
}

export interface PartyExportPage extends PartyMessagePage {
  conversation: PartyConversation;
  exportedAt: string;
  format: "nebula-party-export";
  formatVersion: 1;
  privacy: string;
}

export interface PartyUsersResponse {
  users: PartyUser[];
}

export interface PartyConversationResponse {
  conversation: PartyConversation;
}

export interface PartyNullableConversationResponse {
  conversation: PartyConversation | null;
}

export interface PartyMessageResponse {
  duplicate: boolean;
  message: PartyMessage;
}

export interface PartyAttachmentUploadResponse {
  attachment: PartyAttachment;
  duplicate?: boolean;
  message: PartyMessage;
}

export interface PartyEvent {
  conversationId?: string;
  type: "conversation" | "ready";
}

export interface PartyApiErrorBody {
  code?: string;
  error?: string;
}
