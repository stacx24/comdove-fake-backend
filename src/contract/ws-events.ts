// WebSocket contract for ws://{host}:4020/ws — every frame is { type, ...payload }.
// Owner: Person 3. SHARED with the UI team: any change after the freeze must be
// announced the same day. Spec: docs/superpowers/specs/2026-09-19-ws-events-contract-design.md

import type {
  AutoReplyDTO,
  BusinessNumberDTO,
  CustomerDTO,
  GroupSummaryDTO,
  LogEntryDTO,
} from './api-types.js';

// Shapes shared with the control API (/api/*) come from Person 2's api-types.ts,
// so the admin feed and the HTTP responses can never drift apart.
export type AutoReply = AutoReplyDTO;
export type AutoReplyRule = AutoReplyDTO['rules'][number];
export type ReplyMode = AutoReplyDTO['mode'];
export type BusinessNumber = BusinessNumberDTO;
export type CustomerListItem = CustomerDTO;
export type GroupListItem = GroupSummaryDTO;
export type LogEntry = LogEntryDTO;
export type MessageStatus = 'sent' | 'delivered' | 'read';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_BODY_LENGTH = 4096;
export const MAX_DELAY_MS = 30000;
export const REPLY_MODES: readonly ReplyMode[] = ['manual', 'echo', 'keyword'];

// ---------------------------------------------------------------------------
// Data carried by events
// ---------------------------------------------------------------------------

export type Direction = 'inbound' | 'outbound';

// One chat bubble. `peer` = the business display number on the other side.
export interface WsMessage {
  wamid: string;
  peer: string;
  direction: Direction;
  body: string;
  status: MessageStatus;
  created_at: number;
}

export interface Tile {
  number: string;
  label: string | null;
  online: boolean;
  auto_reply: AutoReply;
  history: WsMessage[]; // oldest first
  queued: WsMessage[]; // outbound, not yet delivered, in seq order
  unread: Record<string, number>; // peer display number -> count
}

export interface Snapshot {
  group: { id: string; name: string };
  business_numbers: Pick<BusinessNumber, 'phone_number_id' | 'display_number' | 'label'>[];
  tiles: Tile[]; // in customers.position order
}

// ---------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------

export const CLIENT_EVENT_TYPES = [
  'group.claim',
  'message.send',
  'tile.presence',
  'chat.read',
  'tile.autoreply',
  'admin.subscribe',
] as const;

export const SERVER_EVENT_TYPES = [
  'group.claimed',
  'group.locked',
  'message.new',
  'queue.flush',
  'message.status',
  'tile.presence',
  'tile.autoreply',
  'error',
] as const;

export const ADMIN_EVENT_TYPES = [
  'log.entry',
  'log.update',
  'log.reset',
  'groups.update',
  'numbers.update',
  'webhook.verify',
] as const;

export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];
export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];
export type AdminEventType = (typeof ADMIN_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type WsErrorCode =
  | 'bad_json' // frame is not valid JSON or not an object
  | 'bad_request' // known type, wrong/missing field (message names the field)
  | 'unknown_type' // type not in CLIENT_EVENT_TYPES
  | 'not_claimed' // group action before group.claim (or on an admin socket)
  | 'already_claimed' // second group.claim / admin.subscribe on the same socket
  | 'unknown_group' // group.claim for a group that does not exist
  | 'number_not_in_group' // action for a tile outside the claimed group
  | 'unknown_business' // message.send / chat.read peer is not a business number
  | 'tile_offline' // message.send from an offline tile
  | 'group_deleted'; // reset wiped the group; the server closes the socket after sending

export type WsError = { type: 'error'; code: WsErrorCode; message: string };

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export type GroupClaim = { type: 'group.claim'; group: string };
export type MessageSend = { type: 'message.send'; from: string; to: string; body: string };
export type TilePresenceIn = { type: 'tile.presence'; number: string; online: boolean };
export type ChatRead = { type: 'chat.read'; number: string; peer: string };
export type TileAutoReplyIn = { type: 'tile.autoreply'; number: string } & AutoReply;
export type AdminSubscribe = { type: 'admin.subscribe' };

export type ClientEvent =
  | GroupClaim
  | MessageSend
  | TilePresenceIn
  | ChatRead
  | TileAutoReplyIn
  | AdminSubscribe;

// ---------------------------------------------------------------------------
// Server -> client (group session)
// ---------------------------------------------------------------------------

export type GroupClaimed = { type: 'group.claimed' } & Snapshot;
export type GroupLocked = { type: 'group.locked'; group: string; since: number };
export type MessageNew = { type: 'message.new'; to: string; number: string; message: WsMessage };
export type QueueFlush = { type: 'queue.flush'; number: string; messages: WsMessage[] };
export type MessageStatusEvent = {
  type: 'message.status';
  wamid: string;
  number: string;
  status: MessageStatus;
  at: number;
};
export type TilePresenceOut = { type: 'tile.presence'; number: string; online: boolean };
export type TileAutoReplyOut = { type: 'tile.autoreply'; number: string } & AutoReply;

export type ServerEvent =
  | GroupClaimed
  | GroupLocked
  | MessageNew
  | QueueFlush
  | MessageStatusEvent
  | TilePresenceOut
  | TileAutoReplyOut
  | WsError;

// ---------------------------------------------------------------------------
// Server -> client (admin feed)
// ---------------------------------------------------------------------------

export type LogEntryEvent = { type: 'log.entry'; entry: LogEntry };
export type LogUpdateEvent = { type: 'log.update'; entry: LogEntry }; // replaces the entry with the same wamid
export type LogResetEvent = { type: 'log.reset' };
export type GroupsUpdateEvent = { type: 'groups.update'; groups: GroupListItem[] };
export type NumbersUpdateEvent = {
  type: 'numbers.update';
  business_numbers: BusinessNumber[];
  customers: CustomerListItem[];
};
export type WebhookVerifyEvent = { type: 'webhook.verify'; ok: boolean; at: number; detail: string };

export type AdminEvent =
  | LogEntryEvent
  | LogUpdateEvent
  | LogResetEvent
  | GroupsUpdateEvent
  | NumbersUpdateEvent
  | WebhookVerifyEvent
  | WsError;

// ---------------------------------------------------------------------------
// Compile-time check: the name lists and the unions stay in sync.
// If one of these lines fails to compile, a list and a union disagree.
// ---------------------------------------------------------------------------

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _clientNamesMatch: Equals<ClientEvent['type'], ClientEventType> = true;
const _serverNamesMatch: Equals<ServerEvent['type'], ServerEventType> = true;
const _adminNamesMatch: Equals<Exclude<AdminEvent['type'], 'error'>, AdminEventType> = true;
void _clientNamesMatch;
void _serverNamesMatch;
void _adminNamesMatch;

// ---------------------------------------------------------------------------
// Encoder — every socket.send goes through this so payloads are type-checked.
// ---------------------------------------------------------------------------

export function encodeEvent(ev: ServerEvent | AdminEvent): string {
  return JSON.stringify(ev);
}
