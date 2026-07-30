import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { RuntimeConfig } from '@zalo-shop/config';
import {
  afterSaleEvidenceResponseSchema,
  afterSaleEvidenceUploadHeadersSchema,
  afterSaleEvidenceUploadResponseSchema,
  type AfterSaleEvidenceResponse,
  type AfterSaleEvidenceUploadRequest,
  type AfterSaleEvidenceUploadResponse,
} from '@zalo-shop/contracts';
import {
  AfterSaleEvidenceLifecycleError,
  confirmAfterSaleEvidenceUpload,
  initializeAfterSaleEvidenceUpload,
  prepareAfterSaleEvidenceUploadConfirmation,
  readMemberAfterSaleEvidenceUpload,
  type AfterSaleEvidenceRecord,
  type PrismaClient,
} from '@zalo-shop/database';
import { createStoreContext, type StoreContext } from '@zalo-shop/domain';
import {
  AfterSaleEvidenceStorageError,
  type AfterSaleEvidenceObjectStorageProvider,
} from '@zalo-shop/integrations';
import { resolveCorrelationId } from '@zalo-shop/logger';

import { AuthService } from '../auth/auth.service';
import { DATABASE_CLIENT } from '../auth/auth.tokens';
import { AfterSalesRateLimiter } from '../after-sales/after-sales-rate-limiter';
import { RUNTIME_CONFIG } from '../health.controller';
import { AFTER_SALE_EVIDENCE_STORAGE_PROVIDER } from './after-sales-evidence.tokens';

type ResolvedStore = { code: string; default_locale: 'en' | 'vi' | 'zh'; id: string };

export type MemberEvidenceHeaders = Readonly<{
  authorization?: string;
  correlationId: string;
  storeCode: string;
}>;

type EnabledEvidenceCapability = Readonly<{
  maxUnclaimedBytes: number;
  maxUnclaimedFiles: number;
  storage: AfterSaleEvidenceObjectStorageProvider;
  uploadTtlSeconds: number;
}>;

function date(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ServiceUnavailableException('Evidence projection is unavailable');
  }
  return value.toISOString();
}

export function projectMemberEvidence(
  evidence: AfterSaleEvidenceRecord,
  observedAt: Date,
): AfterSaleEvidenceResponse {
  if (evidence.status === 'PENDING') {
    const unconfirmedExpired =
      evidence.confirmedAt === null &&
      (evidence.uploadDeadlineAt === null || observedAt >= evidence.uploadDeadlineAt);
    return afterSaleEvidenceResponseSchema.parse({
      access_expires_at: null,
      evidence_id: evidence.id,
      status: unconfirmedExpired ? 'UNAVAILABLE' : 'PENDING',
      version: evidence.version,
    });
  }
  const accessDeadline =
    evidence.status === 'READY_UNCLAIMED'
      ? evidence.claimDeadlineAt
      : evidence.status === 'READY'
        ? evidence.ordinaryAccessDeadlineAt
        : null;
  if (accessDeadline !== null && observedAt < accessDeadline) {
    return afterSaleEvidenceResponseSchema.parse({
      access_expires_at: date(accessDeadline),
      evidence_id: evidence.id,
      status: 'READY',
      version: evidence.version,
    });
  }
  return afterSaleEvidenceResponseSchema.parse({
    access_expires_at: null,
    evidence_id: evidence.id,
    status: 'UNAVAILABLE',
    version: evidence.version,
  });
}

@Injectable()
export class AfterSalesEvidenceService implements OnApplicationShutdown {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AfterSalesRateLimiter) private readonly rateLimiter: AfterSalesRateLimiter,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    @Inject(AFTER_SALE_EVIDENCE_STORAGE_PROVIDER)
    private readonly storage: AfterSaleEvidenceObjectStorageProvider | null,
  ) {}

  public async initialize(input: {
    body: AfterSaleEvidenceUploadRequest;
    headers: MemberEvidenceHeaders;
    idempotencyKey: string;
  }): Promise<Readonly<{ body: AfterSaleEvidenceUploadResponse; replayed: boolean }>> {
    const context = await this.authorize(input.headers);
    await this.consume(context, 'WRITE');
    const capability = this.capability();
    try {
      const initialized = await initializeAfterSaleEvidenceUpload(this.database, context, {
        byteSize: input.body.byte_size,
        checksumSha256: input.body.checksum_sha256,
        deploymentEnvironment: this.config.NODE_ENV,
        filename: input.body.filename,
        idempotencyKey: input.idempotencyKey,
        maxUnclaimedBytes: capability.maxUnclaimedBytes,
        maxUnclaimedFiles: capability.maxUnclaimedFiles,
        mimeType: input.body.mime_type,
        uploadTtlSeconds: capability.uploadTtlSeconds,
      });
      const target = await capability.storage.createUploadTarget({
        byteSize: input.body.byte_size,
        checksumSha256: input.body.checksum_sha256,
        deploymentEnvironment: this.config.NODE_ENV,
        evidenceId: initialized.evidence.id,
        mimeType: input.body.mime_type,
        objectKey: initialized.objectKey,
        storeId: context.storeId,
      });
      return {
        body: afterSaleEvidenceUploadResponseSchema.parse({
          evidence_id: initialized.evidence.id,
          expires_at: date(target.expiresAt),
          upload_headers: afterSaleEvidenceUploadHeadersSchema.parse(target.headers),
          upload_url: target.url,
          version: initialized.evidence.version,
        }),
        replayed: initialized.replayed,
      };
    } catch (error) {
      return this.fail(error);
    }
  }

  public async confirm(input: {
    evidenceId: string;
    expectedVersion: number;
    headers: MemberEvidenceHeaders;
    idempotencyKey: string;
  }): Promise<Readonly<{ body: AfterSaleEvidenceResponse; replayed: boolean }>> {
    const context = await this.authorize(input.headers);
    await this.consume(context, 'WRITE');
    const capability = this.capability();
    try {
      const preparation = await prepareAfterSaleEvidenceUploadConfirmation(this.database, context, {
        evidenceId: input.evidenceId,
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
      });
      if (!preparation.replayed) {
        await capability.storage.validateUploadedObject(preparation.declaration);
      }
      const confirmed = preparation.replayed
        ? preparation
        : await confirmAfterSaleEvidenceUpload(this.database, context, {
            evidenceId: input.evidenceId,
            expectedVersion: input.expectedVersion,
            idempotencyKey: input.idempotencyKey,
          });
      return {
        body: projectMemberEvidence(confirmed.evidence, new Date()),
        replayed: confirmed.replayed,
      };
    } catch (error) {
      return this.fail(error);
    }
  }

  public async status(input: {
    evidenceId: string;
    headers: MemberEvidenceHeaders;
  }): Promise<AfterSaleEvidenceResponse> {
    const context = await this.authorize(input.headers);
    await this.consume(context, 'READ');
    this.capability();
    try {
      const result = await readMemberAfterSaleEvidenceUpload(
        this.database,
        context,
        input.evidenceId,
      );
      return projectMemberEvidence(result.evidence, result.observedAt);
    } catch (error) {
      return this.fail(error);
    }
  }

  public onApplicationShutdown(): void {
    this.storage?.destroy();
  }

  private capability(): EnabledEvidenceCapability {
    if (
      !this.config.AFTER_SALE_EVIDENCE_MEMBER_UPLOADS_ENABLED ||
      this.config.EVIDENCE_STORAGE_PROVIDER !== 's3' ||
      this.config.EVIDENCE_SCANNER_PROVIDER !== 'clamav' ||
      this.config.AFTER_SALE_EVIDENCE_MAX_UNCLAIMED_BYTES === undefined ||
      this.config.AFTER_SALE_EVIDENCE_MAX_UNCLAIMED_FILES === undefined ||
      this.config.AFTER_SALE_EVIDENCE_UPLOAD_TTL_SECONDS === undefined ||
      this.storage === null
    ) {
      throw new ServiceUnavailableException('Evidence uploads are unavailable');
    }
    return {
      maxUnclaimedBytes: this.config.AFTER_SALE_EVIDENCE_MAX_UNCLAIMED_BYTES,
      maxUnclaimedFiles: this.config.AFTER_SALE_EVIDENCE_MAX_UNCLAIMED_FILES,
      storage: this.storage,
      uploadTtlSeconds: this.config.AFTER_SALE_EVIDENCE_UPLOAD_TTL_SECONDS,
    };
  }

  private async authorize(headers: MemberEvidenceHeaders): Promise<StoreContext> {
    if (!headers.authorization?.startsWith('Bearer ') || headers.authorization.length <= 7) {
      throw new UnauthorizedException('Member authentication is required');
    }
    const correlationId = resolveCorrelationId(headers.correlationId);
    const storeCode = headers.storeCode.trim();
    const principal = await this.auth.authenticateAccessToken(
      headers.authorization.slice(7),
      storeCode,
      correlationId,
    );
    if (principal.actorType !== 'member' || !principal.storeId) {
      throw new UnauthorizedException('Member authentication is required');
    }
    const stores = await this.database.$queryRaw<ResolvedStore[]>`
      SELECT * FROM app_security.resolve_active_store(${storeCode})
    `;
    const store = stores[0];
    if (!store || store.id !== principal.storeId) {
      throw new UnauthorizedException('Store context is invalid');
    }
    return createStoreContext({
      actor: { id: principal.subjectId, type: 'member' },
      correlationId,
      locale: store.default_locale,
      storeCode: store.code,
      storeId: store.id,
    });
  }

  private consume(context: StoreContext, access: 'READ' | 'WRITE'): Promise<void> {
    return this.rateLimiter.consume({
      access,
      actorId: context.actor.id,
      actorType: 'MEMBER',
      storeId: context.storeId,
    });
  }

  private fail(error: unknown): never {
    if (error instanceof AfterSaleEvidenceLifecycleError) {
      switch (error.code) {
        case 'AFTER_SALE_EVIDENCE_INPUT_INVALID':
          throw new BadRequestException('Input is invalid');
        case 'AFTER_SALE_EVIDENCE_NOT_FOUND':
          throw new NotFoundException('Resource not found');
        case 'AFTER_SALE_EVIDENCE_SCOPE_DENIED':
          throw new UnauthorizedException('Member authentication is required');
        default:
          throw new ConflictException('Evidence upload conflicts with its current state');
      }
    }
    if (error instanceof AfterSaleEvidenceStorageError) {
      if (
        error.code === 'CONTENT_MISMATCH' ||
        error.code === 'METADATA_MISMATCH' ||
        error.code === 'NOT_FOUND'
      ) {
        throw new ConflictException('Evidence upload could not be confirmed');
      }
      throw new ServiceUnavailableException('Evidence storage is unavailable');
    }
    throw error;
  }
}
