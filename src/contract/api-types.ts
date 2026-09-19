// Shared control-API contract (plan §10). The UI team imports these. Freeze in
// the first 30–45 min; changes after must be announced.

export interface BusinessNumberDTO {
  phone_number_id: string;
  display_number: string;
  label: string | null;
  token: string;
  waba_id: string;
  created_at: number;
}

export interface GroupSummaryDTO {
  id: string;
  name: string;
  count: number;
  status: 'free' | 'locked';
  locked_since: number | null;
}

export interface CustomerDTO {
  number: string;
  label: string | null;
  group_id: string;
  online: boolean;
  effective_online: boolean;
  claim_status: 'free' | 'locked';
  reply_mode: 'manual' | 'echo' | 'keyword';
  type: 'customer';
}

export interface AutoReplyDTO {
  mode: 'manual' | 'echo' | 'keyword';
  delay_ms: number;
  rules: Array<{ keyword: string; reply: string }>;
}

export interface LogEntryDTO {
  wamid: string;
  time: number;
  direction: 'outbound' | 'inbound';
  source: 'api' | 'tile' | 'inject' | 'autoreply';
  from: string;
  to: string;
  business: { phone_number_id: string; label: string | null } | null;
  group_id: string | null;
  body: string;
  status: 'sent' | 'delivered' | 'read';
  timeline: Array<{ status: 'sent' | 'delivered' | 'read'; at: number }>;
  webhooks: Array<{
    kind: 'inbound' | 'sent' | 'delivered' | 'read';
    state: 'pending' | 'ok' | 'failed';
    attempts: Array<{ n: number; http_status: number | null; duration_ms: number | null; at: number }>;
  }>;
}

// A Meta request the emulator rejected (plan §8c, §10c): never stored as a message, so
// no wamid, and never updated. GET /api/log and the admin feed both carry these.
export interface RejectedLogEntryDTO {
  wamid: null;
  time: number;
  direction: 'rejected';
  phone_number_id: string;
  to: string | null;
  body: string | null;
  http_status: number;
  code: number;
  subcode: number | null;
  forced: boolean;
}

/** One row of GET /api/log (newest first): a message, or a rejected Meta request. */
export type LogItemDTO = LogEntryDTO | RejectedLogEntryDTO;

// Request bodies
export interface RegisterBusinessNumberBody {
  display_number: string;
  label?: string;
  phone_number_id?: string;
  waba_id?: string;
  token?: string;
}
export interface CreateGroupBody {
  name: string;
  numbers: string[];
  labels?: Record<string, string>;
}
export interface PresenceBody {
  number: string;
  online: boolean;
}
export interface InjectBody {
  from: string;
  to: string;
  body: string;
}
export interface ResetBody {
  keep_numbers?: boolean;
}
