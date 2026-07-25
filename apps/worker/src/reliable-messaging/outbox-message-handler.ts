import { Inject, Injectable } from '@nestjs/common';
import type { OutboxMessageRecord } from '@zalo-shop/database';
import type { OutboxFailureDisposition } from '@zalo-shop/domain';

import { OUTBOX_MESSAGE_HANDLERS } from '../worker.tokens';

export interface OutboxMessageHandler {
  readonly eventType: string;
  readonly eventVersions: ReadonlySet<number>;
  handle(message: OutboxMessageRecord): Promise<void>;
}

export class OutboxHandlerError extends Error {
  public constructor(
    public readonly code: string,
    public readonly disposition: OutboxFailureDisposition,
  ) {
    super(code);
    this.name = 'OutboxHandlerError';
  }
}

@Injectable()
export class OutboxMessageDispatcher {
  readonly #handlers = new Map<string, OutboxMessageHandler>();

  public constructor(@Inject(OUTBOX_MESSAGE_HANDLERS) handlers: readonly OutboxMessageHandler[]) {
    for (const handler of handlers) {
      for (const version of handler.eventVersions) {
        const key = this.key(handler.eventType, version);
        if (this.#handlers.has(key)) {
          throw new Error(`Duplicate outbox handler registration: ${key}`);
        }
        this.#handlers.set(key, handler);
      }
    }
  }

  public async dispatch(message: OutboxMessageRecord): Promise<void> {
    const handler = this.#handlers.get(this.key(message.eventType, message.eventVersion));
    if (!handler) {
      throw new OutboxHandlerError('UNSUPPORTED_EVENT_VERSION', 'PERMANENT');
    }
    await handler.handle(message);
  }

  private key(eventType: string, eventVersion: number): string {
    return `${eventType}\u0000${String(eventVersion)}`;
  }
}
