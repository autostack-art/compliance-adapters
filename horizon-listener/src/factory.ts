/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

import { HorizonListener, type HorizonListenerOptions } from './listener';
import { RpcEventSource, type RpcEventSourceOptions } from './eventSource';
import { HttpWebhookSender, type HttpWebhookSenderOptions } from './webhook';

export interface WebhookForwarderOptions {
  eventSource: RpcEventSourceOptions;
  webhook: HttpWebhookSenderOptions;
  listenerOptions?: Omit<HorizonListenerOptions, 'eventSource' | 'onEvent'>;
}

export function createWebhookForwarder(
  options: WebhookForwarderOptions,
): HorizonListener {
  const eventSource = new RpcEventSource(options.eventSource);
  const webhook = new HttpWebhookSender(options.webhook);

  return new HorizonListener({
    ...options.listenerOptions,
    eventSource,
    onEvent: async (event) => {
      await webhook.send(event);
    },
  });
}
