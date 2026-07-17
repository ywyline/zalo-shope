import { createHash, randomUUID } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ConfirmMediaUploadInput,
  CreateProductDraftInput,
  MediaUploadInput,
  ProductMediaInput,
  ReplaceProductSkusInput,
  ReviewComplianceRecordInput,
  SubmitComplianceRecordInput,
} from '@zalo-shop/contracts';
import type { Prisma, PrismaClient, StoreTransaction } from '@zalo-shop/database';
import { withStoreTransaction } from '@zalo-shop/database';
import { canonicalSkuCombinationKey, evaluateProductPublication } from '@zalo-shop/domain';
import type { MediaStorageProvider } from '@zalo-shop/integrations';

import { AdminService, type AdminHeaders } from '../admin/admin.service';
import { DATABASE_CLIENT, MEDIA_STORAGE_PROVIDER } from '../auth/auth.tokens';

type CatalogContext = { headers: AdminHeaders; storeId: string };

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, item]) => [key, jsonSafe(item)]),
    );
  }
  return value;
}

@Injectable()
export class ProductAdminService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(MEDIA_STORAGE_PROVIDER) private readonly mediaStorage: MediaStorageProvider,
  ) {}

  public async listProducts(request: CatalogContext) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.read',
    );
    return withStoreTransaction(this.database, context, async (transaction) => ({
      items: jsonSafe(
        await transaction.product.findMany({
          include: {
            product_localizations: true,
            skus: {
              select: { code: true, marketPriceVnd: true, salePriceVnd: true, status: true },
            },
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        }),
      ),
    }));
  }

  public async createProduct(request: CatalogContext, input: CreateProductDraftInput) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.manage',
    );
    try {
      return await withStoreTransaction(this.database, context, async (transaction) => {
        const [brand, category, secondaryCategories, binding] = await Promise.all([
          transaction.brand.findUnique({
            where: { storeId_id: { id: input.brand_id, storeId: request.storeId } },
          }),
          transaction.category.findUnique({
            where: { storeId_id: { id: input.main_category_id, storeId: request.storeId } },
          }),
          transaction.category.findMany({
            where: { id: { in: input.secondary_category_ids }, storeId: request.storeId },
          }),
          transaction.categoryAttributeTemplate.findFirst({
            include: { attribute_template_versions: true },
            where: {
              categoryId: input.main_category_id,
              isPrimary: true,
              storeId: request.storeId,
            },
          }),
        ]);
        if (
          !brand ||
          !category ||
          secondaryCategories.length !== new Set(input.secondary_category_ids).size
        ) {
          throw new NotFoundException('Resource not found');
        }
        if (brand.status !== 'ACTIVE' || category.status !== 'ACTIVE' || category.depth !== 2) {
          throw new ConflictException('Product requires an active brand and leaf category');
        }
        if (input.secondary_category_ids.includes(input.main_category_id)) {
          throw new ConflictException('Main category cannot also be secondary');
        }
        if (!binding || binding.attribute_template_versions.status !== 'ACTIVE') {
          throw new ConflictException(
            'Main category requires an active primary attribute template',
          );
        }
        const created = await transaction.product.create({
          data: {
            attributeTemplateVersionId: binding.templateVersionId,
            brandId: input.brand_id,
            code: input.code,
            createdBy: context.actor.id,
            mainCategoryId: input.main_category_id,
            storeId: request.storeId,
            updatedBy: context.actor.id,
          },
        });
        await transaction.productLocalization.createMany({
          data: input.localizations.map((localization) => ({
            descriptionDocument: { type: 'text', value: localization.description ?? '' },
            locale: localization.locale,
            name: localization.name,
            productId: created.id,
            sellingPoints: localization.selling_points,
            storeId: request.storeId,
          })),
        });
        await transaction.productSecondaryCategory.createMany({
          data: input.secondary_category_ids.map((categoryId) => ({
            categoryId,
            productId: created.id,
            storeId: request.storeId,
          })),
        });
        const after = await this.loadProduct(transaction, request.storeId, created.id);
        await this.admin.writeAudit(transaction, context, {
          action: 'catalog.product.created',
          after,
          targetId: created.id,
          targetType: 'product',
        });
        return jsonSafe(after);
      });
    } catch (error) {
      if (isUniqueConflict(error)) throw new ConflictException('Product code already exists');
      throw error;
    }
  }

  public async replaceSkus(
    request: CatalogContext,
    productId: string,
    input: ReplaceProductSkusInput,
  ) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.manage',
    );
    try {
      return await withStoreTransaction(this.database, context, async (transaction) => {
        const before = await this.loadProduct(transaction, request.storeId, productId);
        if (!before) throw new NotFoundException('Resource not found');
        if (!['DRAFT', 'UNPUBLISHED'].includes(before.status)) {
          throw new ConflictException('Only editable product drafts can change SKUs');
        }
        if (before.version !== input.expected_version)
          throw new ConflictException('Product version conflict');
        const templateVersionId = before.attributeTemplateVersionId;
        if (!templateVersionId) throw new ConflictException('Product has no attribute template');
        const definitions = await transaction.attributeDefinition.findMany({
          include: { attribute_options: true },
          where: { purpose: 'SPECIFICATION', storeId: request.storeId, templateVersionId },
        });
        const definitionByCode = new Map(
          definitions.map((definition) => [definition.code, definition]),
        );
        const prepared = input.skus.map((sku) => {
          const key = canonicalSkuCombinationKey(
            sku.option_values.map((option) => ({
              attributeCode: option.attribute_code,
              optionCode: option.option_code,
            })),
          );
          const selections = sku.option_values.map((selection) => {
            const definition = definitionByCode.get(selection.attribute_code);
            const option = definition?.attribute_options.find(
              (item) => item.code === selection.option_code,
            );
            if (!definition || !option) throw new NotFoundException('Resource not found');
            return { attributeDefinitionId: definition.id, optionId: option.id };
          });
          const selectedDefinitionIds = new Set(
            selections.map((selection) => selection.attributeDefinitionId),
          );
          if (
            definitions.some(
              (definition) => definition.required && !selectedDefinitionIds.has(definition.id),
            )
          ) {
            throw new ConflictException('Every required SKU specification must be selected');
          }
          return { key, selections, sku };
        });
        if (new Set(prepared.map(({ key }) => key)).size !== prepared.length) {
          throw new ConflictException('Duplicate SKU option combination');
        }
        const oldSkuIds = before.skus.map((sku) => sku.id);
        if (oldSkuIds.length > 0) {
          if (
            (await transaction.skuMedia.count({
              where: { skuId: { in: oldSkuIds }, storeId: request.storeId },
            })) > 0
          ) {
            throw new ConflictException('Detach SKU media before replacing SKUs');
          }
          await transaction.skuOptionValue.deleteMany({
            where: { skuId: { in: oldSkuIds }, storeId: request.storeId },
          });
          await transaction.sku.deleteMany({
            where: { id: { in: oldSkuIds }, storeId: request.storeId },
          });
        }
        for (const item of prepared) {
          const hash = createHash('sha256').update(item.key).digest('hex');
          const created = await transaction.sku.create({
            data: {
              barcode: item.sku.barcode,
              code: item.sku.code,
              costPriceVnd: item.sku.cost_price_vnd,
              createdBy: context.actor.id,
              marketPriceVnd: item.sku.market_price_vnd,
              optionCombinationHash: hash,
              optionCombinationKey: item.key,
              productId,
              salePriceVnd: item.sku.sale_price_vnd,
              status: item.sku.enabled ? 'ACTIVE' : 'DISABLED',
              storeId: request.storeId,
              updatedBy: context.actor.id,
              weightGrams: item.sku.weight_grams,
            },
          });
          await transaction.skuOptionValue.createMany({
            data: item.selections.map((selection) => ({
              ...selection,
              skuId: created.id,
              storeId: request.storeId,
            })),
          });
        }
        await transaction.product.update({
          data: { updatedBy: context.actor.id, version: { increment: 1 } },
          where: { storeId_id: { id: productId, storeId: request.storeId } },
        });
        const after = await this.loadProduct(transaction, request.storeId, productId);
        await this.admin.writeAudit(transaction, context, {
          action: 'catalog.product.skus_replaced',
          after,
          before,
          targetId: productId,
          targetType: 'product',
        });
        return jsonSafe(after);
      });
    } catch (error) {
      if (isUniqueConflict(error))
        throw new ConflictException('SKU code or combination already exists');
      throw error;
    }
  }

  public async initializeMedia(request: CatalogContext, input: MediaUploadInput) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      input.resource === 'page' ? 'store.content.manage' : 'store.catalog.manage',
    );
    const id = randomUUID();
    const objectKey = `${process.env.NODE_ENV ?? 'development'}/${request.storeId}/${input.resource}/${id}`;
    const media = await withStoreTransaction(this.database, context, async (transaction) => {
      const created = await transaction.mediaAsset.create({
        data: {
          byteSize: input.byte_size,
          checksumSha256: input.checksum_sha256,
          createdBy: context.actor.id,
          id,
          mimeType: input.mime_type,
          objectKey,
          originalFilename: input.filename,
          storeId: request.storeId,
          updatedBy: context.actor.id,
        },
      });
      await this.admin.writeAudit(transaction, context, {
        action:
          input.resource === 'page'
            ? 'content.media.upload_initialized'
            : 'catalog.media.upload_initialized',
        after: created,
        targetId: id,
        targetType: 'media_asset',
      });
      return created;
    });
    const upload = await this.mediaStorage.createUploadTarget({
      byteSize: input.byte_size,
      checksumSha256: input.checksum_sha256,
      contentType: input.mime_type,
      objectKey,
    });
    return { media: jsonSafe(media), upload };
  }

  public async confirmMedia(
    request: CatalogContext,
    mediaId: string,
    input: ConfirmMediaUploadInput,
  ) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      input.resource === 'page' ? 'store.content.manage' : 'store.catalog.manage',
    );
    const media = await withStoreTransaction(this.database, context, (transaction) =>
      transaction.mediaAsset.findUnique({
        where: { storeId_id: { id: mediaId, storeId: request.storeId } },
      }),
    );
    if (!media) throw new NotFoundException('Resource not found');
    if (input.resource && !media.objectKey.includes(`/${request.storeId}/${input.resource}/`)) {
      throw new ConflictException('Media resource does not match confirmation usage');
    }
    if (media.version !== input.expected_version || media.status !== 'PENDING') {
      throw new ConflictException('Media version or status conflict');
    }
    const object = await this.mediaStorage.inspectObject(media.objectKey);
    const checksumMatches =
      !object.checksumSha256 || object.checksumSha256 === media.checksumSha256;
    const metadataMatches =
      object.byteSize === Number(media.byteSize) && object.contentType === media.mimeType;
    const status =
      metadataMatches && checksumMatches && media.mimeType !== 'image/svg+xml'
        ? 'READY'
        : 'QUARANTINED';
    return withStoreTransaction(this.database, context, async (transaction) => {
      const updated = await transaction.mediaAsset.update({
        data: {
          failureCode:
            status === 'READY'
              ? null
              : media.mimeType === 'image/svg+xml'
                ? 'SVG_SANITIZATION_REQUIRED'
                : 'METADATA_MISMATCH',
          status,
          updatedBy: context.actor.id,
          version: { increment: 1 },
        },
        where: { storeId_id: { id: mediaId, storeId: request.storeId } },
      });
      await this.admin.writeAudit(transaction, context, {
        action: 'catalog.media.upload_confirmed',
        after: updated,
        before: media,
        targetId: mediaId,
        targetType: 'media_asset',
      });
      return jsonSafe(updated);
    });
  }

  public async attachProductMedia(
    request: CatalogContext,
    productId: string,
    input: ProductMediaInput,
  ) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.manage',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const [product, media] = await Promise.all([
        transaction.product.findUnique({
          where: { storeId_id: { id: productId, storeId: request.storeId } },
        }),
        transaction.mediaAsset.findUnique({
          where: { storeId_id: { id: input.media_id, storeId: request.storeId } },
        }),
      ]);
      if (!product || !media) throw new NotFoundException('Resource not found');
      if (product.version !== input.expected_version)
        throw new ConflictException('Product version conflict');
      if (!['DRAFT', 'UNPUBLISHED'].includes(product.status) || media.status !== 'READY') {
        throw new ConflictException('Product or media is not attachable');
      }
      if (!media.objectKey.includes(`/${request.storeId}/product/`)) {
        throw new ConflictException('Media resource does not match product usage');
      }
      if (input.purpose === 'PRIMARY') {
        await transaction.productMedia.deleteMany({
          where: { productId, purpose: 'PRIMARY', storeId: request.storeId },
        });
      }
      await transaction.productMedia.create({
        data: {
          mediaId: input.media_id,
          productId,
          purpose: input.purpose,
          sortOrder: input.sort_order,
          storeId: request.storeId,
        },
      });
      await transaction.product.update({
        data: { updatedBy: context.actor.id, version: { increment: 1 } },
        where: { storeId_id: { id: productId, storeId: request.storeId } },
      });
      const after = await this.loadProduct(transaction, request.storeId, productId);
      await this.admin.writeAudit(transaction, context, {
        action: 'catalog.product.media_attached',
        after,
        targetId: productId,
        targetType: 'product',
      });
      return jsonSafe(after);
    });
  }

  public async submitCompliance(request: CatalogContext, input: SubmitComplianceRecordInput) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.manage',
    );
    await this.admin.authorize(request.headers, request.storeId, 'store.compliance.read');
    return withStoreTransaction(this.database, context, async (transaction) => {
      const [product, requirement, media, superseded] = await Promise.all([
        transaction.product.findUnique({
          where: { storeId_id: { id: input.product_id, storeId: request.storeId } },
        }),
        transaction.complianceRequirement.findUnique({
          where: { storeId_id: { id: input.requirement_id, storeId: request.storeId } },
        }),
        transaction.mediaAsset.findMany({
          where: { id: { in: input.media_ids }, status: 'READY', storeId: request.storeId },
        }),
        input.supersedes_record_id
          ? transaction.complianceRecord.findUnique({
              where: { storeId_id: { id: input.supersedes_record_id, storeId: request.storeId } },
            })
          : Promise.resolve(null),
      ]);
      if (!product || !requirement || media.length !== new Set(input.media_ids).size)
        throw new NotFoundException('Resource not found');
      if (
        requirement.status !== 'ACTIVE' ||
        (requirement.categoryId && requirement.categoryId !== product.mainCategoryId)
      ) {
        throw new ConflictException('Compliance requirement does not apply to product');
      }
      if (
        superseded &&
        (superseded.productId !== product.id || superseded.requirementId !== requirement.id)
      ) {
        throw new ConflictException('Superseded record does not match product and requirement');
      }
      if (media.some((item) => !item.objectKey.includes(`/${request.storeId}/compliance/`))) {
        throw new ConflictException('Media resource does not match compliance usage');
      }
      const record = await transaction.complianceRecord.create({
        data: {
          documentNumber: input.document_number,
          expiresAt: input.expires_at,
          issuedAt: input.issued_at,
          productId: product.id,
          requirementId: requirement.id,
          status: 'PENDING_REVIEW',
          storeId: request.storeId,
          submittedBy: context.actor.id,
          supersedesRecordId: input.supersedes_record_id,
          version: (superseded?.version ?? 0) + 1,
        },
      });
      await transaction.complianceRecordMedia.createMany({
        data: input.media_ids.map((mediaId) => ({
          complianceRecordId: record.id,
          mediaId,
          storeId: request.storeId,
        })),
      });
      await this.admin.writeAudit(transaction, context, {
        action: 'catalog.compliance.submitted',
        after: record,
        targetId: record.id,
        targetType: 'compliance_record',
      });
      return jsonSafe(record);
    });
  }

  public async reviewCompliance(
    request: CatalogContext,
    recordId: string,
    input: ReviewComplianceRecordInput,
  ) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.compliance.review',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const before = await transaction.complianceRecord.findUnique({
        where: { storeId_id: { id: recordId, storeId: request.storeId } },
      });
      if (!before) throw new NotFoundException('Resource not found');
      if (before.submittedBy === context.actor.id)
        throw new ForbiddenException('Submitters cannot review their own record');
      if (before.status !== 'PENDING_REVIEW')
        throw new ConflictException('Compliance record is not pending review');
      const after = await transaction.complianceRecord.update({
        data: {
          reviewNote: input.review_note,
          reviewedAt: new Date(),
          reviewedBy: context.actor.id,
          status: input.decision,
        },
        where: { storeId_id: { id: recordId, storeId: request.storeId } },
      });
      await this.admin.writeAudit(transaction, context, {
        action: `catalog.compliance.${input.decision === 'APPROVED' ? 'approved' : 'rejected'}`,
        after,
        before,
        targetId: recordId,
        targetType: 'compliance_record',
      });
      return jsonSafe(after);
    });
  }

  public async submitProduct(request: CatalogContext, productId: string, expectedVersion: number) {
    return this.transitionProduct(request, productId, expectedVersion, false);
  }

  public async publishProduct(request: CatalogContext, productId: string, expectedVersion: number) {
    return this.transitionProduct(request, productId, expectedVersion, true);
  }

  private async transitionProduct(
    request: CatalogContext,
    productId: string,
    expectedVersion: number,
    publish: boolean,
  ) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.publish',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const before = await this.loadProduct(transaction, request.storeId, productId);
      if (!before) throw new NotFoundException('Resource not found');
      if (before.version !== expectedVersion)
        throw new ConflictException('Product version conflict');
      if (
        publish
          ? before.status !== 'PENDING_REVIEW'
          : !['DRAFT', 'UNPUBLISHED'].includes(before.status)
      ) {
        throw new ConflictException('Product status does not allow this command');
      }
      const decision = await this.publicationDecision(transaction, request.storeId, productId);
      if (!decision.canPublish) return { can_publish: false, issues: decision.issues };
      if (!publish) {
        const after = await transaction.product.update({
          data: {
            status: 'PENDING_REVIEW',
            updatedBy: context.actor.id,
            version: { increment: 1 },
          },
          where: { storeId_id: { id: productId, storeId: request.storeId } },
        });
        await this.admin.writeAudit(transaction, context, {
          action: 'catalog.product.submitted',
          after,
          before,
          targetId: productId,
          targetType: 'product',
        });
        return { can_publish: true, issues: [], product: after };
      }
      const snapshot = jsonSafe(before) as Prisma.InputJsonValue;
      const contentHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
      const nextVersion =
        (
          await transaction.productVersion.aggregate({
            _max: { version: true },
            where: { productId, storeId: request.storeId },
          })
        )._max.version ?? 0;
      const version = await transaction.productVersion.create({
        data: {
          contentHash,
          createdBy: context.actor.id,
          productId,
          publicationStatus: 'PUBLISHED',
          publishedAt: new Date(),
          publishedBy: context.actor.id,
          snapshot,
          storeId: request.storeId,
          version: nextVersion + 1,
        },
      });
      const after = await transaction.product.update({
        data: {
          publishedAt: new Date(),
          status: 'PUBLISHED',
          updatedBy: context.actor.id,
          version: { increment: 1 },
        },
        where: { storeId_id: { id: productId, storeId: request.storeId } },
      });
      await this.admin.writeAudit(transaction, context, {
        action: 'catalog.product.published',
        after: { product: after, version },
        before,
        targetId: productId,
        targetType: 'product',
      });
      return { product: after, version };
    });
  }

  private loadProduct(transaction: StoreTransaction, storeId: string, productId: string) {
    return transaction.product.findUnique({
      include: {
        brands: true,
        categories: true,
        compliance_records: { include: { compliance_requirements: true } },
        product_attribute_values: { include: { attribute_definitions: true } },
        product_localizations: true,
        product_media: { include: { media_assets: true }, orderBy: { sortOrder: 'asc' } },
        product_secondary_categories: true,
        skus: {
          include: {
            sku_option_values: {
              include: { attribute_definitions: true, attribute_options: true },
            },
          },
        },
      },
      where: { storeId_id: { id: productId, storeId } },
    });
  }

  private async publicationDecision(
    transaction: StoreTransaction,
    storeId: string,
    productId: string,
  ) {
    const product = await this.loadProduct(transaction, storeId, productId);
    if (!product) throw new NotFoundException('Resource not found');
    const [definitions, requirements] = await Promise.all([
      product.attributeTemplateVersionId
        ? transaction.attributeDefinition.findMany({
            where: {
              required: true,
              storeId,
              templateVersionId: product.attributeTemplateVersionId,
            },
          })
        : [],
      transaction.complianceRequirement.findMany({
        where: {
          blocking: true,
          OR: [{ categoryId: null }, { categoryId: product.mainCategoryId }],
          status: 'ACTIVE',
          storeId,
        },
      }),
    ]);
    const latestRecords = requirements.flatMap((requirement) => {
      const record = product.compliance_records
        .filter((candidate) => candidate.requirementId === requirement.id)
        .sort((left, right) => right.submittedAt.getTime() - left.submittedAt.getTime())[0];
      return record
        ? [
            {
              ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
              requirementCode: requirement.code,
              ...(record.reviewedBy ? { reviewedBy: record.reviewedBy } : {}),
              status:
                record.status === 'APPROVED'
                  ? ('APPROVED' as const)
                  : record.status === 'REJECTED'
                    ? ('REJECTED' as const)
                    : ('PENDING_REVIEW' as const),
              submittedBy: record.submittedBy,
            },
          ]
        : [];
    });
    const vietnamese = product.product_localizations.find((item) => item.locale === 'vi');
    const description = vietnamese?.descriptionDocument as { value?: unknown } | undefined;
    const skuAttributeCodes = product.skus.flatMap((sku) =>
      sku.sku_option_values.map((item) => item.attribute_definitions.code),
    );
    return evaluateProductPublication({
      brandEnabled: product.brands.status === 'ACTIVE',
      complianceRecords: latestRecords,
      enabled: product.enabled,
      mainCategoryEnabled: product.categories.status === 'ACTIVE' && product.categories.depth === 2,
      primaryMediaReady: product.product_media.some(
        (item) => item.purpose === 'PRIMARY' && item.media_assets.status === 'READY',
      ),
      productAttributeCodes: [
        ...new Set([
          ...product.product_attribute_values.map((item) => item.attribute_definitions.code),
          ...skuAttributeCodes,
        ]),
      ],
      requiredAttributeCodes: definitions.map((item) => item.code),
      requiredComplianceCodes: requirements.map((item) => item.code),
      skus: product.skus.map((sku) => ({
        enabled: sku.status === 'ACTIVE',
        optionCombinationKey: sku.optionCombinationKey,
        salePriceVnd: Number(sku.salePriceVnd),
      })),
      translations: {
        description: typeof description?.value === 'string' ? description.value : '',
        name: vietnamese?.name,
        sellingPoints: vietnamese?.sellingPoints ?? undefined,
      },
    });
  }
}
