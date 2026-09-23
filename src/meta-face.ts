// Person 1's public surface: everything the Meta face exposes to boot, P2 and P3.
//   P2: lifecycle.inbound (inject, auto-reply), dispatcher.cancelAll (reset), verify() (/api/webhook/verify)
//   P3: lifecycle.delivered / read / inbound (WebSocket)
import type { RequestHandler, Router } from 'express';
import type { Bus, Delivery, Registry } from './core/ports.js';
import { createLifecycle, type Lifecycle } from './core/lifecycle.js';
import { createDispatcher, type Dispatcher, type DispatcherOptions } from './webhooks/dispatcher.js';
import type { JobStore } from './webhooks/job-store.js';
import { runHandshake, type HandshakeResult } from './webhooks/verify.js';
import { createMetaRouter, metaNotImplemented } from './meta/messages.route.js';

export interface MetaFaceDeps {
  registry: Registry;
  bus: Bus;
  delivery: Delivery;
  jobStore: JobStore;
  webhookUrl: string;
  appSecret: string;
  verifyToken: string;
  statusDelayMs: number;
  /** Test knobs (retry delays, timeout, clock, webhook concurrency). */
  dispatcher?: Partial<Pick<DispatcherOptions, 'retryDelaysMs' | 'timeoutMs' | 'now' | 'maxParallel'>>;
}

export interface MetaFace {
  /** Mount after /health, /api and /reset. */
  router: Router;
  /** Mount LAST. */
  notImplemented: RequestHandler;
  lifecycle: Lifecycle;
  dispatcher: Dispatcher;
  /** Run the hub.challenge handshake and announce the result on the bus. */
  verify(): Promise<HandshakeResult>;
  /** Boot: resume pending webhooks. The handshake is started separately so it never blocks. */
  start(): void;
}

export function createMetaFace(d: MetaFaceDeps): MetaFace {
  const dispatcher = createDispatcher({
    url: d.webhookUrl,
    secret: d.appSecret,
    store: d.jobStore,
    onChange: (job) => d.bus.emit({ type: 'log.changed', wamid: job.wamid }),
    ...d.dispatcher,
  });
  const lifecycle = createLifecycle({ registry: d.registry, bus: d.bus, dispatcher, statusDelayMs: d.statusDelayMs, now: d.dispatcher?.now });

  return {
    router: createMetaRouter({ registry: d.registry, lifecycle, delivery: d.delivery, bus: d.bus }),
    notImplemented: metaNotImplemented(),
    lifecycle,
    dispatcher,
    async verify() {
      const result = await runHandshake(d.webhookUrl, d.verifyToken);
      d.bus.emit({ type: 'webhook.verify', ...result });
      return result;
    },
    start() {
      dispatcher.resume();
    },
  };
}
