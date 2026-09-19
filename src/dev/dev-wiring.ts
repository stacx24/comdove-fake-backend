// Temporary wiring until P2 (store) and P3 (WebSocket) land — checkpoint ① replaces this.
// Seeds a fixed business number + customers in memory and treats every tile as online,
// so `npm run dev` + curl exercises the full Meta face against a (fake) Comdove.
import { MemoryRegistry } from './memory-registry.js';
import { FakeDelivery } from './memory-bus.js';
import type { Bus, BusEvent, StoredMessage } from '../core/ports.js';

export const DEV_BUSINESS = {
  phone_number_id: 'MOCK-PN-1',
  display_number: '918888800001',
  label: 'Dev business',
  token: 'mock-token-dev',
  waba_id: 'MOCK-WABA-1',
};
export const DEV_CUSTOMERS = ['919876543210', '919876543211', '919876543212'];

export function createDevParts() {
  const registry = new MemoryRegistry().seed({
    business: [DEV_BUSINESS],
    customers: DEV_CUSTOMERS.map((number) => ({ number, group_id: 'dev' })),
  });
  const bus: Bus = {
    emit(e: BusEvent) {
      if (e.type === 'message.status') console.log(`[bus] ${e.status.padEnd(9)} ${e.wamid} → ${e.number}`);
      if (e.type === 'message.new') console.log(`[bus] new ${e.message.direction} ${e.message.wamid}`);
    },
  };
  // Every tile is "online": deliveries are reported straight back to the lifecycle.
  let onDelivered: (m: StoredMessage) => void = () => {};
  const delivery = new FakeDelivery('online', (m) => onDelivered(m));
  return {
    registry,
    bus,
    delivery,
    connect(delivered: (msgs: StoredMessage[]) => void) {
      onDelivered = (m) => delivered([m]);
    },
  };
}
