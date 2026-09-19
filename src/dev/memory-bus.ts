// In-memory stand-ins used by unit tests (the running server uses P2's SQLite store).
import type { Bus, BusEvent, Delivery, StoredMessage } from '../core/ports.js';

/** Records every event (stand-in for P3's bus). */
export class RecordingBus implements Bus {
  events: BusEvent[] = [];
  emit(e: BusEvent) {
    this.events.push(e);
  }
  ofType<T extends BusEvent['type']>(type: T) {
    return this.events.filter((e): e is Extract<BusEvent, { type: T }> => e.type === type);
  }
}

/** Stand-in for P3's delivery: 'online' pushes (and reports delivered), 'offline' queues. */
export class FakeDelivery implements Delivery {
  calls: StoredMessage[] = [];
  constructor(
    public mode: 'online' | 'offline' = 'online',
    private onDelivered?: (m: StoredMessage) => void,
  ) {}
  deliver(m: StoredMessage) {
    this.calls.push(m);
    if (this.mode === 'offline') return 'queued' as const;
    this.onDelivered?.(m);
    return 'delivered' as const;
  }
}
