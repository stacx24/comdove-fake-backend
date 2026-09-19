// Meta Graph API error envelopes (Tech Spec §4, build plan §8).
// wat-backend's readMetaError() reads code / error_subcode (numbers), message, type,
// fbtrace_id and error_data, so every field here is part of the contract.
import { nextTraceId } from './ids.js';

export type MetaErrorKind =
  | 'unknown_object'
  | 'invalid_token'
  | 'invalid_param'
  | 'not_implemented'
  | 'undeliverable'
  | 'rate_limit';

export interface MetaErrorBody {
  error: {
    message: string;
    type: 'OAuthException';
    code: number;
    error_subcode?: number;
    error_data?: { messaging_product: 'whatsapp'; details: string };
    fbtrace_id: string;
  };
}

export interface MetaError {
  status: number;
  body: MetaErrorBody;
}

export interface MetaErrorContext {
  id?: string;
  detail?: string;
  method?: string;
  path?: string;
}

interface Entry {
  status: number;
  code: number;
  subcode?: number;
  message: (c: MetaErrorContext) => string;
  details?: (c: MetaErrorContext) => string | undefined;
}

const CATALOGUE: Record<MetaErrorKind, Entry> = {
  unknown_object: {
    status: 400,
    code: 100,
    subcode: 33,
    message: (c) =>
      `Unsupported post request. Object with ID '${c.id ?? ''}' does not exist, cannot be loaded due to missing permissions, or does not support this operation`,
  },
  invalid_token: {
    status: 401,
    code: 190,
    message: () => 'Invalid OAuth access token - Cannot parse access token',
  },
  invalid_param: {
    status: 400,
    code: 100,
    message: () => '(#100) Invalid parameter',
    details: (c) => c.detail,
  },
  not_implemented: {
    status: 400,
    code: 100,
    message: (c) => `(#100) ${c.method ?? 'POST'} ${c.path ?? ''} is not implemented in comdove-mock`,
  },
  undeliverable: {
    status: 400,
    code: 131026,
    message: () => '(#131026) Message undeliverable',
    details: (c) => c.detail ?? 'Recipient is not a registered mock number',
  },
  rate_limit: {
    status: 400,
    code: 130429,
    message: () => '(#130429) Rate limit hit',
  },
};

export function metaError(kind: MetaErrorKind, ctx: MetaErrorContext = {}): MetaError {
  const e = CATALOGUE[kind];
  const details = e.details?.(ctx);
  return {
    status: e.status,
    body: {
      error: {
        message: e.message(ctx),
        type: 'OAuthException',
        code: e.code,
        ...(e.subcode !== undefined && { error_subcode: e.subcode }),
        ...(details !== undefined && { error_data: { messaging_product: 'whatsapp' as const, details } }),
        fbtrace_id: nextTraceId(),
      },
    },
  };
}

const FORCEABLE: Record<string, MetaErrorKind> = {
  '190': 'invalid_token',
  '33': 'unknown_object',
  '100': 'invalid_param',
  '131026': 'undeliverable',
  '130429': 'rate_limit',
};

/**
 * X-Mock-Force-Error header → the error to return. null when the header is absent.
 * An unsupported value is itself a 400/100 so a typo is never silently ignored.
 */
export function parseForceError(header: string | undefined): { kind: MetaErrorKind; detail?: string } | null {
  if (header === undefined) return null;
  const kind = FORCEABLE[header.trim()];
  return kind ? { kind } : { kind: 'invalid_param', detail: 'unsupported X-Mock-Force-Error value' };
}
