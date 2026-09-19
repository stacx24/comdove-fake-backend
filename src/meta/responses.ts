// Meta success bodies (Tech Spec §3). wat-backend reads messages[0].id as the wamid.

export function sendSuccess(input: string, waId: string, wamid: string) {
  return {
    messaging_product: 'whatsapp' as const,
    contacts: [{ input, wa_id: waId }],
    messages: [{ id: wamid }],
  };
}

export const READ_SUCCESS = Object.freeze({ success: true as const });
