import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  BatchDisableProductsInput,
  BatchMoveProductsInput,
  ComplianceOverviewQuery,
  ConfirmMediaUploadInput,
  CreateProductDraftInput,
  MediaUploadInput,
  ProductAttributeValueInput,
  ProductImportQuery,
  ProductMediaInput,
  ReplaceProductAttributesInput,
  ReplaceProductSkusInput,
  ReviewComplianceRecordInput,
  SubmitComplianceRecordInput,
} from '@zalo-shop/contracts';
import type { Prisma, PrismaClient, StoreTransaction } from '@zalo-shop/database';
import { withStoreTransaction } from '@zalo-shop/database';
import {
  canonicalSkuCombinationKey,
  evaluateProductPublication,
  type StoreContext,
} from '@zalo-shop/domain';
import type { MediaStorageProvider } from '@zalo-shop/integrations';

import { AdminService, type AdminHeaders } from '../admin/admin.service';
import { DATABASE_CLIENT, MEDIA_STORAGE_PROVIDER } from '../auth/auth.tokens';
import {
  PRODUCT_IMPORT_MAX_BYTES,
  ProductImportFileError,
  parseProductImportCsv,
  productImportTemplateCsv,
  type ParsedProductImportRow,
} from './product-import';

type CatalogContext = { headers: AdminHeaders; storeId: string };
export type ProductImportUpload = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
};

type ImportGroup = {
  productCode: string;
  rows: Array<
    ParsedProductImportRow & {
      product: NonNullable<ParsedProductImportRow['product']>;
      sku: NonNullable<ParsedProductImportRow['sku']>;
    }
  >;
};

type ImportRowReport = {
  errors: Array<{ code: string; message: string }>;
  line: number;
  product_code: string;
  product_id?: string;
  status: 'FAILED' | 'IMPORTED' | 'VALIDATED';
};

class ImportGroupError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ImportGroupError';
  }
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

function batchFailure(
  error: unknown,
): { code: 'CONFLICT' | 'RESOURCE_NOT_FOUND'; message: string } | null {
  if (error instanceof NotFoundException) {
    return { code: 'RESOURCE_NOT_FOUND', message: 'Resource not found' };
  }
  if (error instanceof ConflictException) {
    return { code: 'CONFLICT', message: 'Product state or version conflict' };
  }
  return null;
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    const jsonBacked = value as { toJSON?: () => unknown };
    if (typeof jsonBacked.toJSON === 'function') {
      const serialized = jsonBacked.toJSON();
      if (serialized !== value) return jsonSafe(serialized);
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, item]) => [key, jsonSafe(item)]),
    );
  }
  return value;
}

function versionSnapshotForCatalogReader(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(versionSnapshotForCatalogReader);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !['costPriceVnd', 'cost_price_vnd'].includes(key))
        .map(([key, item]) => [key, versionSnapshotForCatalogReader(item)]),
    );
  }
  return value;
}

function productAttributeValueKey(value: ProductAttributeValueInput): string {
  switch (value.data_type) {
    case 'TEXT':
      return `${value.attribute_code}:${value.data_type}:${value.locale}:${value.value}`;
    case 'OPTION':
      return `${value.attribute_code}:${value.data_type}:${value.option_code}`;
    default:
      return `${value.attribute_code}:${value.data_type}:${String(value.value)}`;
  }
}

function maskDocumentNumber(value: string | null): string | null {
  if (value === null) return null;
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}${'*'.repeat(Math.min(8, value.length - 4))}${value.slice(-2)}`;
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

  public async getProductAttributes(request: CatalogContext, productId: string) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.read',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const editor = await this.loadAttributeEditor(transaction, request.storeId, productId);
      if (!editor) throw new NotFoundException('Resource not found');
      return editor;
    });
  }

  public async getComplianceOverview(request: CatalogContext, query: ComplianceOverviewQuery) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.compliance.read',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const [requirements, records] = await Promise.all([
        transaction.complianceRequirement.findMany({
          orderBy: [{ code: 'asc' }, { version: 'desc' }],
          where: { status: 'ACTIVE', storeId: request.storeId },
        }),
        transaction.complianceRecord.findMany({
          include: {
            _count: { select: { compliance_record_media: true } },
            compliance_requirements: true,
            products: {
              select: {
                code: true,
                id: true,
                product_localizations: {
                  select: { name: true },
                  where: { locale: 'vi' },
                },
              },
            },
          },
          orderBy: [{ submittedAt: 'desc' }, { id: 'asc' }],
          take: query.limit,
          where: {
            ...(query.product_id === undefined ? {} : { productId: query.product_id }),
            ...(query.status === undefined ? {} : { status: query.status }),
            storeId: request.storeId,
          },
        }),
      ]);
      return {
        records: records.map((record) => ({
          document_number_masked: maskDocumentNumber(record.documentNumber),
          expires_on: record.expiresAt?.toISOString().slice(0, 10) ?? null,
          id: record.id,
          issued_on: record.issuedAt?.toISOString().slice(0, 10) ?? null,
          media_count: record._count.compliance_record_media,
          product: {
            code: record.products.code,
            id: record.products.id,
            name_vi: record.products.product_localizations[0]?.name ?? record.products.code,
          },
          requirement: {
            blocking: record.compliance_requirements.blocking,
            code: record.compliance_requirements.code,
            document_type: record.compliance_requirements.documentType,
            id: record.compliance_requirements.id,
          },
          reviewed_at: record.reviewedAt?.toISOString() ?? null,
          status: record.status,
          submitted_at: record.submittedAt.toISOString(),
          version: record.version,
        })),
        requirements: requirements.map((requirement) => ({
          blocking: requirement.blocking,
          category_id: requirement.categoryId,
          code: requirement.code,
          document_type: requirement.documentType,
          id: requirement.id,
          version: requirement.version,
        })),
      };
    });
  }

  public async replaceProductAttributes(
    request: CatalogContext,
    productId: string,
    input: ReplaceProductAttributesInput,
  ) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.manage',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const before = await this.loadProduct(transaction, request.storeId, productId);
      if (!before) throw new NotFoundException('Resource not found');
      if (!['DRAFT', 'UNPUBLISHED'].includes(before.status)) {
        throw new ConflictException('Only editable product drafts can change attributes');
      }
      if (before.version !== input.expected_version) {
        throw new ConflictException('Product version conflict');
      }
      if (!before.attributeTemplateVersionId) {
        throw new ConflictException('Product has no attribute template');
      }

      const definitions = await transaction.attributeDefinition.findMany({
        include: { attribute_options: true },
        where: {
          storeId: request.storeId,
          templateVersionId: before.attributeTemplateVersionId,
        },
      });
      const definitionByCode = new Map(
        definitions.map((definition) => [definition.code, definition]),
      );
      const prepared: Prisma.ProductAttributeValueCreateManyInput[] = [];
      const valuesByDefinition = new Map<string, ProductAttributeValueInput[]>();

      for (const value of input.values) {
        const definition = definitionByCode.get(value.attribute_code);
        if (!definition) throw new NotFoundException('Resource not found');
        if (definition.purpose === 'SPECIFICATION') {
          throw new ConflictException('Specification attributes must be maintained through SKUs');
        }
        if (definition.dataType !== value.data_type) {
          throw new ConflictException('Product attribute data type does not match its definition');
        }
        const values = valuesByDefinition.get(definition.id) ?? [];
        values.push(value);
        valuesByDefinition.set(definition.id, values);

        const base = {
          attributeDefinitionId: definition.id,
          productId,
          storeId: request.storeId,
        };
        switch (value.data_type) {
          case 'TEXT':
            prepared.push({ ...base, locale: value.locale, textValue: value.value });
            break;
          case 'INTEGER':
            prepared.push({ ...base, integerValue: BigInt(value.value) });
            break;
          case 'DECIMAL':
            prepared.push({ ...base, decimalValue: value.value });
            break;
          case 'BOOLEAN':
            prepared.push({ ...base, booleanValue: value.value });
            break;
          case 'DATE':
            prepared.push({ ...base, dateValue: new Date(`${value.value}T00:00:00.000Z`) });
            break;
          case 'OPTION': {
            const option = definition.attribute_options.find(
              (candidate) => candidate.code === value.option_code,
            );
            if (!option) throw new NotFoundException('Resource not found');
            if (option.status !== 'ACTIVE') {
              throw new ConflictException('Product attribute option is not active');
            }
            prepared.push({ ...base, optionId: option.id });
            break;
          }
        }
      }

      for (const definition of definitions) {
        const values = valuesByDefinition.get(definition.id) ?? [];
        if (definition.multiple) {
          if (new Set(values.map(productAttributeValueKey)).size !== values.length) {
            throw new ConflictException('Duplicate product attribute value');
          }
          continue;
        }
        if (definition.dataType === 'TEXT') {
          const locales = values.map((value) =>
            value.data_type === 'TEXT' ? value.locale : 'invalid',
          );
          if (new Set(locales).size !== locales.length) {
            throw new ConflictException('Single-value text attributes allow one value per locale');
          }
        } else if (values.length > 1) {
          throw new ConflictException('Single-value attributes allow only one value');
        }
      }

      await transaction.productAttributeValue.deleteMany({
        where: {
          attribute_definitions: { purpose: { not: 'SPECIFICATION' } },
          productId,
          storeId: request.storeId,
        },
      });
      if (prepared.length > 0) {
        await transaction.productAttributeValue.createMany({ data: prepared });
      }
      const updated = await transaction.product.updateMany({
        data: { updatedBy: context.actor.id, version: { increment: 1 } },
        where: {
          id: productId,
          status: { in: ['DRAFT', 'UNPUBLISHED'] },
          storeId: request.storeId,
          version: input.expected_version,
        },
      });
      if (updated.count !== 1) throw new ConflictException('Product version conflict');

      const after = await this.loadProduct(transaction, request.storeId, productId);
      await this.admin.writeAudit(transaction, context, {
        action: 'catalog.product.attributes_replaced',
        after,
        before,
        targetId: productId,
        targetType: 'product',
      });
      const editor = await this.loadAttributeEditor(transaction, request.storeId, productId);
      if (!editor) throw new NotFoundException('Resource not found');
      return editor;
    });
  }

  public async getProductImportTemplate(request: CatalogContext): Promise<Buffer> {
    await this.admin.authorize(request.headers, request.storeId, 'store.catalog.read');
    return productImportTemplateCsv();
  }

  public async importProducts(
    request: CatalogContext,
    query: ProductImportQuery,
    upload: ProductImportUpload | undefined,
  ) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.manage',
    );
    if (!upload) throw new BadRequestException('A CSV file is required');
    const acceptedTypes = new Set([
      'application/csv',
      'application/octet-stream',
      'application/vnd.ms-excel',
      'text/csv',
      'text/plain',
    ]);
    if (
      !upload.originalname.toLowerCase().endsWith('.csv') ||
      !acceptedTypes.has(upload.mimetype.toLowerCase()) ||
      upload.size !== upload.buffer.byteLength ||
      upload.size > PRODUCT_IMPORT_MAX_BYTES
    ) {
      throw new BadRequestException('CSV file metadata is invalid');
    }
    let parsedRows: ParsedProductImportRow[];
    try {
      parsedRows = parseProductImportCsv(upload.buffer);
    } catch (error) {
      if (error instanceof ProductImportFileError) {
        throw new BadRequestException(`Product import file error: ${error.code}`);
      }
      throw error;
    }

    const reports = new Map<number, ImportRowReport>();
    const invalidProductCodes = new Set<string>();
    const groups = new Map<string, ImportGroup>();
    for (const row of parsedRows) {
      if (row.issues.length > 0 || !row.product || !row.sku) {
        if (row.productCode !== '') invalidProductCodes.add(row.productCode);
        reports.set(row.line, {
          errors: row.issues.map((issue) => ({ code: issue.code, message: issue.message })),
          line: row.line,
          product_code: row.productCode,
          status: 'FAILED',
        });
        continue;
      }
      const group = groups.get(row.productCode) ?? { productCode: row.productCode, rows: [] };
      group.rows.push({ ...row, product: row.product, sku: row.sku });
      groups.set(row.productCode, group);
    }

    const skuLines = new Map<string, number[]>();
    for (const group of groups.values()) {
      for (const row of group.rows) {
        const lines = skuLines.get(row.sku.code) ?? [];
        lines.push(row.line);
        skuLines.set(row.sku.code, lines);
      }
    }
    const duplicateSkuCodes = new Set(
      [...skuLines.entries()].filter(([, lines]) => lines.length > 1).map(([code]) => code),
    );

    for (const group of groups.values()) {
      if (
        invalidProductCodes.has(group.productCode) ||
        group.rows.some((row) => duplicateSkuCodes.has(row.sku.code))
      ) {
        const code = invalidProductCodes.has(group.productCode)
          ? 'PRODUCT_GROUP_INVALID'
          : 'DUPLICATE_SKU_IN_FILE';
        for (const row of group.rows) {
          reports.set(row.line, {
            errors: [{ code, message: 'The complete product group must be corrected' }],
            line: row.line,
            product_code: row.productCode,
            status: 'FAILED',
          });
        }
        continue;
      }
      try {
        const result = await withStoreTransaction(this.database, context, (transaction) =>
          this.processProductImportGroup(transaction, context, group, query.dry_run),
        );
        for (const row of group.rows) {
          reports.set(row.line, {
            errors: [],
            line: row.line,
            product_code: row.productCode,
            ...(result.productId === undefined ? {} : { product_id: result.productId }),
            status: query.dry_run ? 'VALIDATED' : 'IMPORTED',
          });
        }
      } catch (error) {
        const failure =
          error instanceof ImportGroupError
            ? { code: error.code, message: error.message }
            : isUniqueConflict(error)
              ? { code: 'CODE_CONFLICT', message: 'Product or SKU code already exists' }
              : null;
        if (!failure) throw error;
        for (const row of group.rows) {
          reports.set(row.line, {
            errors: [failure],
            line: row.line,
            product_code: row.productCode,
            status: 'FAILED',
          });
        }
      }
    }

    const rows = [...reports.values()].sort((left, right) => left.line - right.line);
    const successfulProducts = new Set(
      rows.filter((row) => row.status !== 'FAILED').map((row) => row.product_code),
    );
    const failedProducts = new Set(
      rows
        .filter((row) => row.status === 'FAILED' && row.product_code !== '')
        .map((row) => row.product_code),
    );
    return {
      dry_run: query.dry_run,
      rows,
      summary: {
        products_failed: failedProducts.size,
        products_imported: query.dry_run ? 0 : successfulProducts.size,
        products_validated: query.dry_run ? successfulProducts.size : 0,
        rows_failed: rows.filter((row) => row.status === 'FAILED').length,
        rows_imported: rows.filter((row) => row.status === 'IMPORTED').length,
        rows_total: rows.length,
        rows_validated: rows.filter((row) => row.status === 'VALIDATED').length,
      },
    };
  }

  public async listProductVersions(request: CatalogContext, productId: string) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.read',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const product = await transaction.product.findUnique({
        select: { id: true },
        where: { storeId_id: { id: productId, storeId: request.storeId } },
      });
      if (!product) throw new NotFoundException('Resource not found');
      return {
        items: jsonSafe(
          await transaction.productVersion.findMany({
            orderBy: { version: 'desc' },
            select: {
              contentHash: true,
              createdAt: true,
              createdBy: true,
              publicationStatus: true,
              publishedAt: true,
              publishedBy: true,
              version: true,
              withdrawnAt: true,
              withdrawnBy: true,
            },
            where: { productId, storeId: request.storeId },
          }),
        ),
      };
    });
  }

  public async getProductVersion(request: CatalogContext, productId: string, version: number) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.read',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const item = await transaction.productVersion.findUnique({
        where: {
          storeId_productId_version: { productId, storeId: request.storeId, version },
        },
      });
      if (!item) throw new NotFoundException('Resource not found');
      return jsonSafe({ ...item, snapshot: versionSnapshotForCatalogReader(item.snapshot) });
    });
  }

  public async batchDisableProducts(request: CatalogContext, input: BatchDisableProductsInput) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.publish',
    );
    const results = [];
    for (const item of input.items) {
      try {
        const product = await withStoreTransaction(this.database, context, async (transaction) => {
          const before = await this.loadProduct(transaction, request.storeId, item.product_id);
          if (!before) throw new NotFoundException('Resource not found');
          if (before.status === 'DISABLED' || before.version !== item.expected_version) {
            throw new ConflictException('Product state or version conflict');
          }
          const update = await transaction.product.updateMany({
            data: {
              enabled: false,
              status: 'DISABLED',
              updatedBy: context.actor.id,
              version: { increment: 1 },
            },
            where: {
              id: item.product_id,
              status: { not: 'DISABLED' },
              storeId: request.storeId,
              version: item.expected_version,
            },
          });
          if (update.count !== 1) throw new ConflictException('Product version conflict');
          const after = await this.loadProduct(transaction, request.storeId, item.product_id);
          await this.admin.writeAudit(transaction, context, {
            action: 'catalog.product.disabled',
            after,
            before,
            targetId: item.product_id,
            targetType: 'product',
          });
          return after!;
        });
        results.push({
          product_id: item.product_id,
          status: 'SUCCEEDED',
          version: product.version,
        });
      } catch (error) {
        const failure = batchFailure(error);
        if (!failure) throw error;
        results.push({ error: failure, product_id: item.product_id, status: 'FAILED' });
      }
    }
    return {
      results,
      summary: {
        failed: results.filter((item) => item.status === 'FAILED').length,
        succeeded: results.filter((item) => item.status === 'SUCCEEDED').length,
        total: results.length,
      },
    };
  }

  public async batchMoveProducts(request: CatalogContext, input: BatchMoveProductsInput) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.manage',
    );
    await withStoreTransaction(this.database, context, async (transaction) => {
      await this.loadImportCategoryBinding(
        transaction,
        request.storeId,
        input.main_category_id,
        'id',
      );
    });
    const results = [];
    for (const item of input.items) {
      try {
        const product = await withStoreTransaction(this.database, context, async (transaction) => {
          const before = await this.loadProduct(transaction, request.storeId, item.product_id);
          if (!before) throw new NotFoundException('Resource not found');
          if (
            !['DRAFT', 'UNPUBLISHED'].includes(before.status) ||
            before.version !== item.expected_version
          ) {
            throw new ConflictException('Product state or version conflict');
          }
          const target = await this.loadImportCategoryBinding(
            transaction,
            request.storeId,
            input.main_category_id,
            'id',
          );
          if (
            before.attributeTemplateVersionId !== target.templateVersionId &&
            (before.skus.length > 0 || before.product_attribute_values.length > 0)
          ) {
            throw new ConflictException('Target category uses an incompatible attribute template');
          }
          const update = await transaction.product.updateMany({
            data: {
              attributeTemplateVersionId: target.templateVersionId,
              mainCategoryId: target.categoryId,
              updatedBy: context.actor.id,
              version: { increment: 1 },
            },
            where: {
              id: item.product_id,
              status: { in: ['DRAFT', 'UNPUBLISHED'] },
              storeId: request.storeId,
              version: item.expected_version,
            },
          });
          if (update.count !== 1) throw new ConflictException('Product version conflict');
          await transaction.productSecondaryCategory.deleteMany({
            where: {
              categoryId: target.categoryId,
              productId: item.product_id,
              storeId: request.storeId,
            },
          });
          const after = await this.loadProduct(transaction, request.storeId, item.product_id);
          await this.admin.writeAudit(transaction, context, {
            action: 'catalog.product.main_category_moved',
            after,
            before,
            targetId: item.product_id,
            targetType: 'product',
          });
          return after!;
        });
        results.push({
          product_id: item.product_id,
          status: 'SUCCEEDED',
          version: product.version,
        });
      } catch (error) {
        const failure = batchFailure(error);
        if (!failure) throw error;
        results.push({ error: failure, product_id: item.product_id, status: 'FAILED' });
      }
    }
    return {
      results,
      summary: {
        failed: results.filter((item) => item.status === 'FAILED').length,
        succeeded: results.filter((item) => item.status === 'SUCCEEDED').length,
        total: results.length,
      },
    };
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

  private async processProductImportGroup(
    transaction: StoreTransaction,
    context: StoreContext,
    group: ImportGroup,
    dryRun: boolean,
  ): Promise<{ productId?: string }> {
    const first = group.rows[0];
    if (!first) throw new ImportGroupError('PRODUCT_GROUP_EMPTY', 'Product group has no rows');
    if (group.rows.length > 500) {
      throw new ImportGroupError(
        'SKU_LIMIT_EXCEEDED',
        'A product cannot import more than 500 SKUs',
      );
    }
    const productSignature = JSON.stringify(first.product);
    if (group.rows.some((row) => JSON.stringify(row.product) !== productSignature)) {
      throw new ImportGroupError(
        'PRODUCT_FIELDS_MISMATCH',
        'Product fields must be identical on every SKU row',
      );
    }
    const [brand, existingProduct, existingSkus] = await Promise.all([
      transaction.brand.findUnique({
        where: { storeId_code: { code: first.product.brandCode, storeId: context.storeId } },
      }),
      transaction.product.findUnique({
        where: { storeId_code: { code: group.productCode, storeId: context.storeId } },
      }),
      transaction.sku.findMany({
        select: { code: true },
        where: { code: { in: group.rows.map((row) => row.sku.code) }, storeId: context.storeId },
      }),
    ]);
    if (!brand) throw new ImportGroupError('REFERENCE_NOT_FOUND', 'Brand was not found');
    if (brand.status !== 'ACTIVE') {
      throw new ImportGroupError('REFERENCE_INVALID', 'Brand must be active');
    }
    if (existingProduct || existingSkus.length > 0) {
      throw new ImportGroupError('CODE_CONFLICT', 'Product or SKU code already exists');
    }
    const mainCategory = await this.loadImportCategoryBinding(
      transaction,
      context.storeId,
      first.product.mainCategoryCode,
      'code',
    );
    const secondaryCategories = await transaction.category.findMany({
      where: {
        code: { in: first.product.secondaryCategoryCodes },
        storeId: context.storeId,
      },
    });
    if (secondaryCategories.length !== first.product.secondaryCategoryCodes.length) {
      throw new ImportGroupError('REFERENCE_NOT_FOUND', 'A secondary category was not found');
    }
    if (secondaryCategories.some((category) => category.status !== 'ACTIVE')) {
      throw new ImportGroupError('REFERENCE_INVALID', 'Secondary categories must be active');
    }
    const definitions = await transaction.attributeDefinition.findMany({
      include: { attribute_options: true },
      where: {
        purpose: 'SPECIFICATION',
        storeId: context.storeId,
        templateVersionId: mainCategory.templateVersionId,
      },
    });
    const definitionByCode = new Map(
      definitions.map((definition) => [definition.code, definition]),
    );
    const prepared = group.rows.map((row) => {
      const key = canonicalSkuCombinationKey(
        row.sku.option_values.map((option) => ({
          attributeCode: option.attribute_code,
          optionCode: option.option_code,
        })),
      );
      const selections = row.sku.option_values.map((selection) => {
        const definition = definitionByCode.get(selection.attribute_code);
        const option = definition?.attribute_options.find(
          (candidate) => candidate.code === selection.option_code,
        );
        if (!definition || !option || option.status !== 'ACTIVE') {
          throw new ImportGroupError(
            'SKU_OPTIONS_INVALID',
            `SKU options are invalid at line ${row.line}`,
          );
        }
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
        throw new ImportGroupError(
          'SKU_OPTIONS_INVALID',
          `Required SKU options are missing at line ${row.line}`,
        );
      }
      return { key, row, selections };
    });
    if (new Set(prepared.map((item) => item.key)).size !== prepared.length) {
      throw new ImportGroupError(
        'DUPLICATE_SKU_COMBINATION',
        'SKU option combinations must be unique',
      );
    }
    if (dryRun) return {};

    const created = await transaction.product.create({
      data: {
        attributeTemplateVersionId: mainCategory.templateVersionId,
        brandId: brand.id,
        code: group.productCode,
        createdBy: context.actor.id,
        mainCategoryId: mainCategory.categoryId,
        storeId: context.storeId,
        updatedBy: context.actor.id,
      },
    });
    await transaction.productLocalization.createMany({
      data: first.product.create.localizations.map((localization) => ({
        descriptionDocument: { type: 'text', value: localization.description ?? '' },
        locale: localization.locale,
        name: localization.name,
        productId: created.id,
        sellingPoints: localization.selling_points,
        storeId: context.storeId,
      })),
    });
    await transaction.productSecondaryCategory.createMany({
      data: secondaryCategories.map((category) => ({
        categoryId: category.id,
        productId: created.id,
        storeId: context.storeId,
      })),
    });
    for (const item of prepared) {
      const sku = await transaction.sku.create({
        data: {
          barcode: item.row.sku.barcode,
          code: item.row.sku.code,
          costPriceVnd: item.row.sku.cost_price_vnd,
          createdBy: context.actor.id,
          marketPriceVnd: item.row.sku.market_price_vnd,
          optionCombinationHash: createHash('sha256').update(item.key).digest('hex'),
          optionCombinationKey: item.key,
          productId: created.id,
          salePriceVnd: item.row.sku.sale_price_vnd,
          status: 'ACTIVE',
          storeId: context.storeId,
          updatedBy: context.actor.id,
          weightGrams: item.row.sku.weight_grams,
        },
      });
      await transaction.skuOptionValue.createMany({
        data: item.selections.map((selection) => ({
          ...selection,
          skuId: sku.id,
          storeId: context.storeId,
        })),
      });
    }
    const after = await this.loadProduct(transaction, context.storeId, created.id);
    await this.admin.writeAudit(transaction, context, {
      action: 'catalog.product.imported',
      after,
      targetId: created.id,
      targetType: 'product',
    });
    return { productId: created.id };
  }

  private async loadImportCategoryBinding(
    transaction: StoreTransaction,
    storeId: string,
    reference: string,
    by: 'code' | 'id',
  ): Promise<{ categoryId: string; templateVersionId: string }> {
    const category =
      by === 'code'
        ? await transaction.category.findUnique({
            where: { storeId_code: { code: reference, storeId } },
          })
        : await transaction.category.findUnique({
            where: { storeId_id: { id: reference, storeId } },
          });
    const fail = (code: 'REFERENCE_INVALID' | 'REFERENCE_NOT_FOUND', message: string): never => {
      if (by === 'code') throw new ImportGroupError(code, message);
      if (code === 'REFERENCE_NOT_FOUND') throw new NotFoundException('Resource not found');
      throw new ConflictException(message);
    };
    if (!category) return fail('REFERENCE_NOT_FOUND', 'Main category was not found');
    if (category.status !== 'ACTIVE' || category.depth !== 2) {
      return fail('REFERENCE_INVALID', 'Main category must be an active leaf category');
    }
    const binding = await transaction.categoryAttributeTemplate.findFirst({
      include: { attribute_template_versions: true },
      where: { categoryId: category.id, isPrimary: true, storeId },
    });
    if (!binding || binding.attribute_template_versions.status !== 'ACTIVE') {
      return fail('REFERENCE_INVALID', 'Main category requires an active attribute template');
    }
    return { categoryId: category.id, templateVersionId: binding.templateVersionId };
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
        product_attribute_values: {
          include: { attribute_definitions: true, attribute_options: true },
        },
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

  private async loadAttributeEditor(
    transaction: StoreTransaction,
    storeId: string,
    productId: string,
  ) {
    const product = await transaction.product.findUnique({
      select: { attributeTemplateVersionId: true, id: true, status: true, version: true },
      where: { storeId_id: { id: productId, storeId } },
    });
    if (!product) return null;
    if (!product.attributeTemplateVersionId) {
      throw new ConflictException('Product has no attribute template');
    }
    const [template, values] = await Promise.all([
      transaction.attributeTemplateVersion.findUnique({
        where: {
          storeId_id: { id: product.attributeTemplateVersionId, storeId },
        },
      }),
      transaction.productAttributeValue.findMany({
        include: { attribute_definitions: true, attribute_options: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        where: {
          attribute_definitions: {
            purpose: { not: 'SPECIFICATION' },
            templateVersionId: product.attributeTemplateVersionId,
          },
          productId,
          storeId,
        },
      }),
    ]);
    if (!template) throw new ConflictException('Product attribute template is unavailable');
    const definitions = await transaction.attributeDefinition.findMany({
      include: {
        attribute_options: {
          orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
          where: { status: 'ACTIVE' },
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      where: {
        purpose: { not: 'SPECIFICATION' },
        storeId,
        templateVersionId: product.attributeTemplateVersionId,
      },
    });
    return {
      definitions: definitions.map((definition) => ({
        code: definition.code,
        data_type: definition.dataType,
        filterable: definition.filterable,
        labels: {
          en: definition.labelEn,
          vi: definition.labelVi,
          zh: definition.labelZh,
        },
        multiple: definition.multiple,
        options: definition.attribute_options.map((option) => ({
          code: option.code,
          labels: { en: option.labelEn, vi: option.labelVi, zh: option.labelZh },
          sort_order: option.sortOrder,
        })),
        purpose: definition.purpose,
        required: definition.required,
        sort_order: definition.sortOrder,
        unit: definition.unit,
        validation_rules: definition.validationRules,
      })),
      editable: ['DRAFT', 'UNPUBLISHED'].includes(product.status),
      product_id: product.id,
      product_status: product.status,
      product_version: product.version,
      template_version: { id: template.id, name: template.name, version: template.version },
      values: values.map((value) => {
        const common = {
          attribute_code: value.attribute_definitions.code,
          data_type: value.attribute_definitions.dataType,
        };
        switch (value.attribute_definitions.dataType) {
          case 'TEXT':
            if (value.locale === null || value.textValue === null) {
              throw new ConflictException('Stored product attribute value is inconsistent');
            }
            return { ...common, locale: value.locale, value: value.textValue };
          case 'INTEGER':
            if (
              value.integerValue === null ||
              value.integerValue > BigInt(Number.MAX_SAFE_INTEGER) ||
              value.integerValue < BigInt(Number.MIN_SAFE_INTEGER)
            ) {
              throw new ConflictException('Stored product attribute value is inconsistent');
            }
            return { ...common, value: Number(value.integerValue) };
          case 'DECIMAL':
            if (value.decimalValue === null) {
              throw new ConflictException('Stored product attribute value is inconsistent');
            }
            return { ...common, value: value.decimalValue.toString() };
          case 'BOOLEAN':
            if (value.booleanValue === null) {
              throw new ConflictException('Stored product attribute value is inconsistent');
            }
            return { ...common, value: value.booleanValue };
          case 'DATE':
            if (value.dateValue === null) {
              throw new ConflictException('Stored product attribute value is inconsistent');
            }
            return { ...common, value: value.dateValue.toISOString().slice(0, 10) };
          case 'OPTION':
            if (value.attribute_options === null || value.optionId === null) {
              throw new ConflictException('Stored product attribute value is inconsistent');
            }
            return { ...common, option_code: value.attribute_options.code };
        }
      }),
    };
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
    const skuAttributeCodes = product.skus
      .filter((sku) => sku.status === 'ACTIVE')
      .flatMap((sku) =>
        sku.sku_option_values.flatMap((item) =>
          item.attribute_definitions.templateVersionId === product.attributeTemplateVersionId &&
          item.attribute_definitions.purpose === 'SPECIFICATION' &&
          item.attribute_options.status === 'ACTIVE'
            ? [item.attribute_definitions.code]
            : [],
        ),
      );
    const productAttributeCodes = product.product_attribute_values.flatMap((value) => {
      const definition = value.attribute_definitions;
      if (
        definition.templateVersionId !== product.attributeTemplateVersionId ||
        definition.purpose === 'SPECIFICATION'
      ) {
        return [];
      }
      switch (definition.dataType) {
        case 'TEXT':
          return value.locale === 'vi' && value.textValue?.trim() ? [definition.code] : [];
        case 'INTEGER':
          return value.integerValue === null ? [] : [definition.code];
        case 'DECIMAL':
          return value.decimalValue === null ? [] : [definition.code];
        case 'BOOLEAN':
          return value.booleanValue === null ? [] : [definition.code];
        case 'DATE':
          return value.dateValue === null ? [] : [definition.code];
        case 'OPTION':
          return value.optionId !== null && value.attribute_options?.status === 'ACTIVE'
            ? [definition.code]
            : [];
      }
    });
    return evaluateProductPublication({
      brandEnabled: product.brands.status === 'ACTIVE',
      complianceRecords: latestRecords,
      enabled: product.enabled,
      mainCategoryEnabled: product.categories.status === 'ACTIVE' && product.categories.depth === 2,
      primaryMediaReady: product.product_media.some(
        (item) => item.purpose === 'PRIMARY' && item.media_assets.status === 'READY',
      ),
      productAttributeCodes: [...new Set([...productAttributeCodes, ...skuAttributeCodes])],
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
