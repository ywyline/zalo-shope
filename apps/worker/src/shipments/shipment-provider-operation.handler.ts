import type {
  OutboxMessageRecord,
  PrismaClient,
  SHIPMENT_QUERY_EVENT_TYPE,
} from '@zalo-shop/database';
import {
  applyShippingProviderFact,
  getShipmentProviderOperationRequest,
  SHIPMENT_CANCEL_EVENT_TYPE,
} from '@zalo-shop/database';
import type { ShippingProviderResolver } from '@zalo-shop/integrations';

import {
  OutboxHandlerError,
  type OutboxMessageHandler,
} from '../reliable-messaging/outbox-message-handler';
import {
  mapShippingFailure,
  shipmentOperationIdentity,
  shippingContext,
} from './shipment-handler-support';

export class ShipmentProviderOperationHandler implements OutboxMessageHandler {
  public readonly eventVersions = new Set([1]);

  public constructor(
    public readonly eventType: typeof SHIPMENT_CANCEL_EVENT_TYPE | typeof SHIPMENT_QUERY_EVENT_TYPE,
    private readonly database: PrismaClient,
    private readonly providers: ShippingProviderResolver,
  ) {}

  public async handle(message: OutboxMessageRecord): Promise<void> {
    const identity = shipmentOperationIdentity(message);
    const context = shippingContext(message.storeId, `shipment-operation:${message.id}`);
    try {
      const request = await getShipmentProviderOperationRequest(
        this.database,
        context,
        identity.shipmentId,
        identity.operationId,
      );
      const expected = this.eventType === SHIPMENT_CANCEL_EVENT_TYPE ? 'CANCEL' : 'QUERY_TRACKING';
      if (request.operationType !== expected) {
        throw new OutboxHandlerError('SHIPMENT_OUTBOX_PAYLOAD_INVALID', 'PERMANENT');
      }
      if (request.operationStatus !== 'PENDING') return;
      const provider = this.providers.resolve({ ...request.channel, storeId: request.storeId });
      const fact =
        request.operationType === 'CANCEL'
          ? await provider.cancelShipment({
              operationId: request.operationId,
              providerShipmentId: request.providerShipmentId,
              storeId: request.storeId,
            })
          : await provider.queryShipment({
              providerShipmentId: request.providerShipmentId,
              storeId: request.storeId,
            });
      await applyShippingProviderFact(this.database, context, {
        fact,
        operationId: identity.operationId,
        operationType: request.operationType,
        shipmentId: identity.shipmentId,
        source: 'QUERY',
      });
    } catch (error) {
      await mapShippingFailure(this.database, context, identity.operationId, error);
    }
  }
}
