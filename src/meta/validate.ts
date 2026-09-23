// Validation pipeline for POST /{version}/{phone_number_id}/messages (build plan §7b).
// Pure: no Express, no I/O beyond registry lookups, so every rule is unit-testable.
//
//   0. X-Mock-Force-Error          → that error
//   1. unknown phone_number_id     → 400 / 100 / 33
//   2. bearer token                → 401 / 190
//   3. JSON object, product        → 400 / 100
//   4. send (type) or read (status)→ 400 / 100
//   5. type text, body, to         → 400 / 100
//   6. recipient is a customer     → 400 / 131026
import type { BusinessNumber, Registry } from '../core/ports.js';
import { metaError, parseForceError, type MetaError } from './errors.js';
import { normalizeNumber } from './ids.js';

export const MAX_TEXT_LENGTH = 4096;

export interface ValidateInput {
  phoneNumberId: string;
  auth?: string;
  forceError?: string;
  body: unknown;
}

export type ValidateResult =
  | { kind: 'send'; business: BusinessNumber; to: string; waId: string; text: string }
  | { kind: 'read'; business: BusinessNumber; messageId: string }
  | { kind: 'error'; error: MetaError; forced: boolean };

type Lookups = Pick<Registry, 'getBusiness' | 'getCustomer' | 'getMessage'>;

const fail = (error: MetaError, forced = false): ValidateResult => ({ kind: 'error', error, forced });
const invalid = (detail: string) => fail(metaError('invalid_param', { detail }));

function bearerToken(auth: string | undefined): string | null {
  const m = auth?.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validate(input: ValidateInput, reg: Lookups): ValidateResult {
  const forced = parseForceError(input.forceError);
  if (forced) return fail(metaError(forced.kind, { id: input.phoneNumberId, detail: forced.detail }), true);

  // Only a phone_number_id addresses the endpoint; a display number is not a Graph object id.
  const business = reg.getBusiness(input.phoneNumberId);
  if (!business || business.phone_number_id !== input.phoneNumberId) {
    return fail(metaError('unknown_object', { id: input.phoneNumberId }));
  }

  if (bearerToken(input.auth) !== business.token) return fail(metaError('invalid_token'));

  const body = input.body;
  if (!isObject(body)) return invalid('request body must be a JSON object');
  if (body.messaging_product !== 'whatsapp') return invalid('messaging_product must be "whatsapp"');

  if (body.type === undefined && body.status !== undefined) {
    if (body.status !== 'read') return invalid('status must be "read"');
    const id = body.message_id;
    const msg = typeof id === 'string' ? reg.getMessage(id) : null;
    if (!msg || msg.direction !== 'inbound' || msg.phone_number_id !== business.phone_number_id) {
      return invalid('message_id is not an inbound message for this phone number');
    }
    return { kind: 'read', business, messageId: msg.wamid };
  }

  if (body.type === undefined) return invalid('type is required');

  // Accept template messages — extract a readable text so they show up in the fake UI.
  if (body.type === 'template') {
    if (body.to === undefined) return invalid('to is required');
    const waId = normalizeNumber(body.to);
    if (!waId) return invalid('to must be a phone number');
    if (!reg.getCustomer(waId)) return fail(metaError('undeliverable'));

    const tmpl = isObject(body.template) ? body.template : null;
    const templateName = typeof tmpl?.name === 'string' ? tmpl.name : 'unknown';
    const components = Array.isArray(tmpl?.components) ? (tmpl.components as unknown[]) : [];
    const params: string[] = [];
    for (const comp of components) {
      if (isObject(comp) && Array.isArray(comp.parameters)) {
        for (const param of comp.parameters as unknown[]) {
          if (isObject(param) && param.type === 'text' && typeof param.text === 'string') {
            params.push(param.text);
          }
        }
      }
    }
    const text = params.length > 0 ? `[Template: ${templateName}] ${params.join(' ')}` : `[Template: ${templateName}]`;
    return { kind: 'send', business, to: body.to as string, waId, text };
  }

  if (body.type !== 'text') {
    return fail(metaError('not_implemented', { what: `message type "${String(body.type)}"` }));
  }

  const text = isObject(body.text) ? body.text.body : undefined;
  if (typeof text !== 'string' || text.length === 0) return invalid('text.body is required');
  if (text.length > MAX_TEXT_LENGTH) return invalid(`text.body must be at most ${MAX_TEXT_LENGTH} characters`);

  if (body.to === undefined) return invalid('to is required');
  const waId = normalizeNumber(body.to);
  if (!waId) return invalid('to must be a phone number');

  if (!reg.getCustomer(waId)) return fail(metaError('undeliverable'));

  return { kind: 'send', business, to: body.to as string, waId, text };
}
