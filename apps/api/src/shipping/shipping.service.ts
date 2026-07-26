import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import type { ShipmentCreateRequest } from '@zalo-shop/contracts';
import {
  createShipmentCommand,
  getShippingQuotePreparation,
  recordShippingQuote,
  requestShipmentOperation,
  ShippingCommandError,
  type PrismaClient,
  withStoreTransaction,
} from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import {
  GHN_LABEL_PATH,
  ghnOrigin,
  ProviderIntegrationError,
  type ShippingProviderResolver,
} from '@zalo-shop/integrations';
import { decryptSensitive, signJwt, verifyJwt } from '@zalo-shop/security';

import { AdminService, type AdminHeaders } from '../admin/admin.service';
import { AuthService } from '../auth/auth.service';
import { DATABASE_CLIENT } from '../auth/auth.tokens';
import { RUNTIME_CONFIG } from '../health.controller';
import { SHIPPING_PROVIDER } from './shipping.tokens';

const LABEL_PROXY_TTL_SECONDS = 60;
const LABEL_RESPONSE_MAX_BYTES = 8 * 1_024 * 1_024;

type StoreRecord = { code: string; default_locale: 'en' | 'vi' | 'zh'; id: string };

function shippingCommandView(result: {
  operationId: string;
  operationStatus: string;
  orderId: string;
  providerShipmentReferenceMasked: string | null;
  publicShipmentNumber: string;
  replayed: boolean;
  shipmentId: string;
  status: string;
  version: number;
}) {
  return {
    operation_id: result.operationId,
    operation_status: result.operationStatus,
    order_id: result.orderId,
    provider_shipment_reference_masked: result.providerShipmentReferenceMasked,
    public_number: result.publicShipmentNumber,
    replayed: result.replayed,
    shipment_id: result.shipmentId,
    status: result.status,
    version: result.version,
  };
}

@Injectable()
export class ShippingService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    @Inject(SHIPPING_PROVIDER) private readonly providers: ShippingProviderResolver,
  ) {}

  public async quote(
    headers: AdminHeaders,
    storeId: string,
    input: { order_id: string; service_code?: string },
  ) {
    const context = await this.admin.authorize(headers, storeId, 'store.shipments.create');
    let preparation;
    try {
      preparation = await getShippingQuotePreparation(this.database, context, {
        orderId: input.order_id,
        providerEnvironment: this.providerEnvironment(),
        ...(input.service_code ? { serviceCode: input.service_code } : {}),
      });
      const provider = this.providers.resolve({ ...preparation.channel, storeId });
      const quote = await provider.quote({
        codAmountVnd: preparation.codAmountVnd,
        destination: this.decryptAddress(preparation.destination),
        origin: this.decryptAddress(preparation.origin),
        parcel: preparation.parcel,
        serviceCode: preparation.serviceCode,
        storeId,
      });
      const recorded = await recordShippingQuote(this.database, context, {
        baseFeeVnd: quote.baseFeeVnd,
        channelId: preparation.channel.id,
        codFeeVnd: quote.codFeeVnd,
        ...(quote.estimatedDeliveryAt ? { estimatedDeliveryAt: quote.estimatedDeliveryAt } : {}),
        expiresAt: quote.expiresAt,
        insuranceFeeVnd: quote.insuranceFeeVnd,
        orderId: preparation.orderId,
        orderVersion: preparation.orderVersion,
        otherFeeVnd: quote.otherFeeVnd,
        ...(quote.providerQuoteId ? { providerQuoteId: quote.providerQuoteId } : {}),
        ...(quote.providerServiceId ? { providerServiceId: quote.providerServiceId } : {}),
        ...(quote.providerServiceTypeId
          ? { providerServiceTypeId: quote.providerServiceTypeId }
          : {}),
        remoteFeeVnd: quote.remoteFeeVnd,
        requestHash: preparation.requestHash,
        serviceCode: quote.serviceCode,
        totalFeeVnd: quote.totalFeeVnd,
      });
      return {
        base_fee_vnd: recorded.baseFeeVnd,
        cod_fee_vnd: recorded.codFeeVnd,
        estimated_delivery_at: recorded.estimatedDeliveryAt?.toISOString() ?? null,
        expires_at: recorded.expiresAt.toISOString(),
        id: recorded.id,
        insurance_fee_vnd: recorded.insuranceFeeVnd,
        other_fee_vnd: recorded.otherFeeVnd,
        remote_fee_vnd: recorded.remoteFeeVnd,
        service_code: recorded.serviceCode,
        source: recorded.source,
        total_fee_vnd: recorded.totalFeeVnd,
      };
    } catch (error) {
      this.mapError(error);
    }
  }

  public async create(
    headers: AdminHeaders,
    storeId: string,
    orderId: string,
    idempotencyKey: string,
    input: ShipmentCreateRequest,
  ) {
    const context = await this.admin.authorizeSensitive(headers, storeId, 'store.shipments.create');
    try {
      return shippingCommandView(
        await createShipmentCommand(this.database, context, {
          expectedOrderVersion: input.expected_order_version,
          idempotencyKey,
          inspectionPolicy: input.inspection_policy,
          orderId,
          providerEnvironment: this.providerEnvironment(),
          reason: input.reason,
          serviceCode: input.service_code,
        }),
      );
    } catch (error) {
      this.mapError(error);
    }
  }

  public cancel(
    headers: AdminHeaders,
    storeId: string,
    shipmentId: string,
    idempotencyKey: string,
    input: { expected_version: number; reason: string },
  ) {
    return this.requestOperation(
      headers,
      storeId,
      shipmentId,
      idempotencyKey,
      input,
      'store.shipments.cancel',
      'CANCEL',
    );
  }

  public sync(
    headers: AdminHeaders,
    storeId: string,
    shipmentId: string,
    idempotencyKey: string,
    input: { expected_version: number; reason: string },
  ) {
    return this.requestOperation(
      headers,
      storeId,
      shipmentId,
      idempotencyKey,
      input,
      'store.shipments.reconcile',
      'QUERY_TRACKING',
    );
  }

  public async issueLabelAccess(
    headers: AdminHeaders,
    storeId: string,
    shipmentId: string,
    format: 'A5' | 'THERMAL_80X80' | 'THERMAL_52X70',
  ) {
    if (format !== 'A5') throw new ConflictException('SHIPMENT_LABEL_FORMAT_UNAVAILABLE');
    const context = await this.admin.authorize(headers, storeId, 'store.shipments.label.read');
    const shipment = await withStoreTransaction(this.database, context, async (transaction) => {
      const current = await transaction.shipment.findFirst({
        select: { id: true, providerShipmentId: true },
        where: { id: shipmentId, storeId },
      });
      if (!current?.providerShipmentId) throw new NotFoundException('Shipment not found');
      await this.admin.writeAudit(transaction, context, {
        action: 'shipping.shipment.label_access_issued',
        after: { format, shipment_id: current.id },
        targetId: current.id,
        targetType: 'shipment',
      });
      return current;
    });
    const now = Math.floor(Date.now() / 1_000);
    const token = signJwt(
      {
        actor_id: context.actor.id,
        aud: this.labelAudience(),
        exp: now + LABEL_PROXY_TTL_SECONDS,
        format,
        iat: now,
        iss: this.labelIssuer(),
        jti: randomUUID(),
        kind: 'shipping_label_proxy',
        shipment_id: shipment.id,
        store_code: context.storeCode,
        store_id: storeId,
        sub: context.actor.id,
      },
      this.config.AUTH_JWT_SECRET,
    );
    return {
      expires_at: new Date((now + LABEL_PROXY_TTL_SECONDS) * 1_000).toISOString(),
      url: `/v1/shipping/labels/${encodeURIComponent(token)}`,
    };
  }

  public async proxyLabel(token: string): Promise<{ body: Buffer; contentType: string }> {
    const claims = this.verifyLabelToken(token);
    const context = createStoreContext({
      actor: { id: claims.actorId, type: 'admin' },
      correlationId: randomUUID(),
      locale: 'vi',
      storeCode: claims.storeCode,
      storeId: claims.storeId,
    });
    const shipment = await withStoreTransaction(this.database, context, (transaction) =>
      transaction.shipment.findFirst({
        include: { channel: true },
        where: { id: claims.shipmentId, storeId: claims.storeId },
      }),
    );
    if (!shipment?.providerShipmentId) throw new NotFoundException('Shipment not found');
    let upstream;
    try {
      upstream = await this.providers.resolve(shipment.channel).getLabel({
        format: claims.format,
        providerShipmentId: shipment.providerShipmentId,
        storeId: claims.storeId,
      });
    } catch (error) {
      this.mapError(error);
    }
    const labelUrl = this.assertLabelUrl(upstream.url, shipment.channel.providerEnvironment);
    const body = await this.fetchLabel(labelUrl);
    await withStoreTransaction(this.database, context, (transaction) =>
      this.admin.writeAudit(transaction, context, {
        action: 'shipping.shipment.label_read',
        after: { format: claims.format, shipment_id: shipment.id },
        targetId: shipment.id,
        targetType: 'shipment',
      }),
    );
    return { body, contentType: 'application/pdf' };
  }

  public async memberShipment(input: {
    authorization?: string;
    orderId: string;
    storeCode: string;
  }) {
    const member = await this.memberContext(input.authorization, input.storeCode);
    return withStoreTransaction(this.database, member.context, async (transaction) => {
      const order = await transaction.order.findFirst({
        select: { id: true },
        where: { id: input.orderId, memberId: member.memberId, storeId: member.context.storeId },
      });
      if (!order) throw new NotFoundException('Order not found');
      const shipment = await transaction.shipment.findFirst({
        include: { events: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] } },
        orderBy: { createdAt: 'desc' },
        where: { orderId: order.id, storeId: member.context.storeId },
      });
      if (!shipment) return { shipment: null };
      return {
        shipment: {
          created_at: shipment.createdAt.toISOString(),
          delivered_at: shipment.deliveredAt?.toISOString() ?? null,
          public_number: shipment.publicShipmentNumber,
          status: shipment.status,
          tracking_events: shipment.events.map((event) => ({
            location_masked: event.locationMasked,
            message_key: event.messageKey,
            occurred_at: event.occurredAt.toISOString(),
            status: event.status,
          })),
          updated_at: shipment.updatedAt.toISOString(),
        },
      };
    });
  }

  public async adminShipment(headers: AdminHeaders, storeId: string, orderId: string) {
    const context = await this.admin.authorize(headers, storeId, 'store.shipments.read');
    return withStoreTransaction(this.database, context, async (transaction) => {
      const order = await transaction.order.findFirst({
        select: { id: true },
        where: { id: orderId, storeId },
      });
      if (!order) throw new NotFoundException('Order not found');
      const shipment = await transaction.shipment.findFirst({
        include: {
          events: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] },
          operations: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: { createdAt: 'desc' },
        where: { orderId: order.id, storeId },
      });
      if (!shipment) return { shipment: null };
      return {
        shipment: {
          created_at: shipment.createdAt.toISOString(),
          label_ready: shipment.providerShipmentId !== null,
          latest_operation_status: shipment.operations[0]?.status ?? null,
          provider_reference_masked: this.maskProviderReference(shipment.providerShipmentId),
          public_number: shipment.publicShipmentNumber,
          service_code: shipment.serviceCode,
          shipment_id: shipment.id,
          status: shipment.status,
          tracking_events: shipment.events.map((event) => ({
            location_masked: event.locationMasked,
            message_key: event.messageKey,
            occurred_at: event.occurredAt.toISOString(),
            status: event.status,
          })),
          updated_at: shipment.updatedAt.toISOString(),
          version: shipment.version,
        },
      };
    });
  }

  private async requestOperation(
    headers: AdminHeaders,
    storeId: string,
    shipmentId: string,
    idempotencyKey: string,
    input: { expected_version: number; reason: string },
    permission: string,
    operationType: 'CANCEL' | 'QUERY_TRACKING',
  ) {
    const context = await this.admin.authorizeSensitive(headers, storeId, permission);
    try {
      return shippingCommandView(
        await requestShipmentOperation(this.database, context, {
          expectedVersion: input.expected_version,
          idempotencyKey,
          operationType,
          reason: input.reason,
          shipmentId,
        }),
      );
    } catch (error) {
      this.mapError(error);
    }
  }

  private decryptAddress(address: {
    addressLineCiphertext: string;
    districtCode: string;
    nameCiphertext: string;
    phoneCiphertext: string;
    provinceCode: string;
    wardCode: string;
  }) {
    return {
      addressLine: decryptSensitive(address.addressLineCiphertext, this.config.PII_ENCRYPTION_KEY),
      districtCode: address.districtCode,
      name: decryptSensitive(address.nameCiphertext, this.config.PII_ENCRYPTION_KEY),
      phoneE164: decryptSensitive(address.phoneCiphertext, this.config.PII_ENCRYPTION_KEY),
      provinceCode: address.provinceCode,
      wardCode: address.wardCode,
    };
  }

  private maskProviderReference(value: string | null): string | null {
    if (!value) return null;
    if (value.length <= 4) return '*'.repeat(value.length);
    return `${value.slice(0, 2)}${'*'.repeat(Math.min(8, value.length - 4))}${value.slice(-2)}`;
  }

  private providerEnvironment(): 'SANDBOX' | 'PRODUCTION' {
    return this.config.NODE_ENV === 'production' ? 'PRODUCTION' : 'SANDBOX';
  }

  private labelAudience(): string {
    return `${this.config.AUTH_JWT_AUDIENCE}:shipping-label`;
  }

  private labelIssuer(): string {
    return `${this.config.AUTH_JWT_ISSUER}:shipping-label`;
  }

  private verifyLabelToken(token: string): {
    actorId: string;
    format: 'A5';
    shipmentId: string;
    storeCode: string;
    storeId: string;
  } {
    let claims: ReturnType<typeof verifyJwt>;
    try {
      claims = verifyJwt(token, {
        audience: this.labelAudience(),
        issuer: this.labelIssuer(),
        secret: this.config.AUTH_JWT_SECRET,
      });
    } catch {
      throw new UnauthorizedException('Shipping label access is invalid');
    }
    if (
      claims.kind !== 'shipping_label_proxy' ||
      claims.format !== 'A5' ||
      typeof claims.actor_id !== 'string' ||
      typeof claims.shipment_id !== 'string' ||
      typeof claims.store_code !== 'string' ||
      typeof claims.store_id !== 'string'
    ) {
      throw new UnauthorizedException('Shipping label access is invalid');
    }
    return {
      actorId: claims.actor_id,
      format: claims.format,
      shipmentId: claims.shipment_id,
      storeCode: claims.store_code,
      storeId: claims.store_id,
    };
  }

  private assertLabelUrl(value: string, environment: 'SANDBOX' | 'PRODUCTION'): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ServiceUnavailableException('SHIPMENT_LABEL_UPSTREAM_INVALID');
    }
    const parameters = [...url.searchParams.keys()];
    if (
      url.protocol !== 'https:' ||
      url.origin !== ghnOrigin(environment) ||
      url.pathname !== GHN_LABEL_PATH ||
      url.username ||
      url.password ||
      url.hash ||
      parameters.length !== 1 ||
      parameters[0] !== 'token' ||
      !url.searchParams.get('token')
    ) {
      throw new ServiceUnavailableException('SHIPMENT_LABEL_UPSTREAM_INVALID');
    }
    return url;
  }

  private async fetchLabel(url: URL): Promise<Buffer> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept: 'application/pdf' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.GHN_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ServiceUnavailableException('SHIPMENT_LABEL_UPSTREAM_UNAVAILABLE');
    }
    if (!response.ok || !response.headers.get('content-type')?.startsWith('application/pdf')) {
      throw new ServiceUnavailableException('SHIPMENT_LABEL_UPSTREAM_INVALID');
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > LABEL_RESPONSE_MAX_BYTES) {
      throw new ServiceUnavailableException('SHIPMENT_LABEL_UPSTREAM_INVALID');
    }
    if (!response.body) {
      throw new ServiceUnavailableException('SHIPMENT_LABEL_UPSTREAM_INVALID');
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        totalBytes += chunk.value.byteLength;
        if (totalBytes > LABEL_RESPONSE_MAX_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // The response size violation remains authoritative.
          }
          throw new ServiceUnavailableException('SHIPMENT_LABEL_UPSTREAM_INVALID');
        }
        chunks.push(Buffer.from(chunk.value));
      }
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('SHIPMENT_LABEL_UPSTREAM_INVALID');
    } finally {
      reader.releaseLock();
    }
    if (totalBytes === 0) {
      throw new ServiceUnavailableException('SHIPMENT_LABEL_UPSTREAM_INVALID');
    }
    return Buffer.concat(chunks, totalBytes);
  }

  private async memberContext(authorization: string | undefined, storeCode: string) {
    if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
      throw new UnauthorizedException('Member authentication is required');
    }
    const claims = await this.auth.authenticateAccessToken(authorization.slice(7), storeCode);
    if (claims.actorType !== 'member' || !claims.storeId) {
      throw new UnauthorizedException('Member authentication is required');
    }
    const stores = await this.database.$queryRaw<StoreRecord[]>`
      SELECT * FROM app_security.resolve_active_store(${storeCode.trim()})
    `;
    const store = stores[0];
    if (!store || store.id !== claims.storeId) {
      throw new UnauthorizedException('Store context is invalid');
    }
    return {
      context: createStoreContext({
        actor: { id: claims.subjectId, type: 'member' },
        correlationId: randomUUID(),
        locale: store.default_locale,
        storeCode: store.code,
        storeId: store.id,
      }),
      memberId: claims.subjectId,
    };
  }

  private mapError(error: unknown): never {
    if (error instanceof ShippingCommandError) {
      if (error.code === 'SHIPMENT_NOT_FOUND' || error.code === 'SHIPMENT_OPERATION_NOT_FOUND') {
        throw new NotFoundException('Shipment not found');
      }
      if (error.code === 'SHIPPING_CHANNEL_UNAVAILABLE') {
        throw new ServiceUnavailableException(error.code);
      }
      throw new ConflictException(error.code);
    }
    if (error instanceof ProviderIntegrationError) {
      if (error.code === 'INVALID_REQUEST') throw new BadRequestException('SHIPMENT_INPUT_INVALID');
      if (error.code === 'REJECTED') throw new ConflictException('SHIPMENT_PROVIDER_REJECTED');
      if (error.code === 'AUTHENTICATION') throw new ForbiddenException('SHIPMENT_PROVIDER_DENIED');
      throw new ServiceUnavailableException('SHIPMENT_PROVIDER_UNAVAILABLE');
    }
    throw error;
  }
}
