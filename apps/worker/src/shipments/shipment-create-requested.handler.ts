import type { RuntimeConfig } from '@zalo-shop/config';
import type { OutboxMessageRecord, PrismaClient } from '@zalo-shop/database';
import {
  getShipmentCreationRequest,
  recordShipmentCreated,
  SHIPMENT_CREATE_EVENT_TYPE,
} from '@zalo-shop/database';
import type { ShippingProviderResolver } from '@zalo-shop/integrations';

import type { OutboxMessageHandler } from '../reliable-messaging/outbox-message-handler';
import {
  decryptShippingAddress,
  mapShippingFailure,
  shipmentOperationIdentity,
  shippingContext,
} from './shipment-handler-support';

export class ShipmentCreateRequestedHandler implements OutboxMessageHandler {
  public readonly eventType = SHIPMENT_CREATE_EVENT_TYPE;
  public readonly eventVersions = new Set([1]);

  public constructor(
    private readonly database: PrismaClient,
    private readonly providers: ShippingProviderResolver,
    private readonly config: Pick<RuntimeConfig, 'PII_ENCRYPTION_KEY'>,
  ) {}

  public async handle(message: OutboxMessageRecord): Promise<void> {
    const identity = shipmentOperationIdentity(message);
    const context = shippingContext(message.storeId, `shipment-create:${message.id}`);
    try {
      const request = await getShipmentCreationRequest(
        this.database,
        context,
        identity.shipmentId,
        identity.operationId,
      );
      if (request.operationStatus !== 'PENDING' || request.status !== 'CREATION_PENDING') return;
      const provider = this.providers.resolve({ ...request.channel, storeId: request.storeId });
      const fact = await provider.createShipment({
        clientOrderCode: request.clientOrderCode,
        codAmountVnd: request.codAmountVnd,
        destination: decryptShippingAddress(request.destination, this.config),
        inspectionPolicy: request.inspectionPolicy,
        items: request.items,
        operationId: request.operationId,
        origin: decryptShippingAddress(request.origin, this.config),
        parcel: request.parcel,
        serviceCode: request.serviceCode,
        storeId: request.storeId,
      });
      await recordShipmentCreated(this.database, context, {
        fact,
        operationId: identity.operationId,
        shipmentId: identity.shipmentId,
      });
    } catch (error) {
      await mapShippingFailure(this.database, context, identity.operationId, error);
    }
  }
}
