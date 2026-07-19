import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  AttributeTemplateVersionInput,
  CreateAttributeTemplateInput,
  CreateBrandInput,
  CreateCategoryInput,
  UpdateAttributeTemplateVersionInput,
  UpdateBrandInput,
  UpdateCategoryInput,
} from '@zalo-shop/contracts';
import type { Prisma, PrismaClient, StoreTransaction } from '@zalo-shop/database';
import { withStoreTransaction } from '@zalo-shop/database';

import { AdminService, type AdminHeaders } from '../admin/admin.service';
import { DATABASE_CLIENT } from '../auth/auth.tokens';

type CatalogContext = { headers: AdminHeaders; storeId: string };

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

function validVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version < 1)
    throw new NotFoundException('Resource not found');
  return version;
}

@Injectable()
export class CatalogAdminService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AdminService) private readonly admin: AdminService,
  ) {}

  public async listBrands(request: CatalogContext) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.read',
    );
    return withStoreTransaction(this.database, context, async (transaction) => ({
      items: await transaction.brand.findMany({
        include: { brand_localizations: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
    }));
  }

  public async createBrand(request: CatalogContext, input: CreateBrandInput) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.manage',
    );
    try {
      return await withStoreTransaction(this.database, context, async (transaction) => {
        const created = await transaction.brand.create({
          data: {
            code: input.code,
            countryCode: input.country_code,
            createdBy: context.actor.id,
            recommended: input.recommended,
            sortOrder: input.sort_order,
            storeId: request.storeId,
            updatedBy: context.actor.id,
            websiteUrl: input.official_website,
          },
        });
        await transaction.brandLocalization.createMany({
          data: input.localizations.map((localization) => ({
            brandId: created.id,
            introduction: localization.description,
            locale: localization.locale,
            name: localization.name,
            shareSummary: localization.share_summary,
            shareTitle: localization.share_title,
            storeId: request.storeId,
          })),
        });
        const brand = await transaction.brand.findUniqueOrThrow({
          include: { brand_localizations: true },
          where: { storeId_id: { id: created.id, storeId: request.storeId } },
        });
        await this.admin.writeAudit(transaction, context, {
          action: 'catalog.brand.created',
          after: brand,
          targetId: brand.id,
          targetType: 'brand',
        });
        return brand;
      });
    } catch (error) {
      if (isUniqueConflict(error)) throw new ConflictException('Brand code already exists');
      throw error;
    }
  }

  public async updateBrand(request: CatalogContext, brandId: string, input: UpdateBrandInput) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.manage',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const before = await transaction.brand.findUnique({
        include: { brand_localizations: true },
        where: { storeId_id: { id: brandId, storeId: request.storeId } },
      });
      if (!before) throw new NotFoundException('Resource not found');
      const updated = await transaction.brand.updateMany({
        data: {
          countryCode: input.country_code,
          recommended: input.recommended,
          sortOrder: input.sort_order,
          status: input.status,
          updatedBy: context.actor.id,
          version: { increment: 1 },
          websiteUrl: input.official_website,
        },
        where: { id: brandId, storeId: request.storeId, version: input.expected_version },
      });
      if (updated.count !== 1) throw new ConflictException('Brand version conflict');
      for (const localization of input.localizations ?? []) {
        await transaction.brandLocalization.upsert({
          create: {
            brandId,
            introduction: localization.description,
            locale: localization.locale,
            name: localization.name,
            shareSummary: localization.share_summary,
            shareTitle: localization.share_title,
            storeId: request.storeId,
          },
          update: {
            introduction: localization.description,
            name: localization.name,
            shareSummary: localization.share_summary,
            shareTitle: localization.share_title,
          },
          where: {
            storeId_brandId_locale: {
              brandId,
              locale: localization.locale,
              storeId: request.storeId,
            },
          },
        });
      }
      const after = await transaction.brand.findUniqueOrThrow({
        include: { brand_localizations: true },
        where: { storeId_id: { id: brandId, storeId: request.storeId } },
      });
      await this.admin.writeAudit(transaction, context, {
        action: 'catalog.brand.updated',
        after,
        before,
        targetId: brandId,
        targetType: 'brand',
      });
      return after;
    });
  }

  public async listCategories(request: CatalogContext) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.read',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const categories = await transaction.category.findMany({
        include: {
          category_attribute_templates: {
            include: {
              attribute_template_versions: {
                select: {
                  id: true,
                  name: true,
                  status: true,
                  version: true,
                  attribute_templates: { select: { code: true, id: true } },
                },
              },
            },
          },
          category_localizations: true,
        },
        orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
      });
      return categories
        .filter((category) => category.parentId === null)
        .map((category) => ({
          ...category,
          children: categories.filter((child) => child.parentId === category.id),
        }));
    });
  }

  public async createCategory(request: CatalogContext, input: CreateCategoryInput) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.manage',
    );
    try {
      return await withStoreTransaction(this.database, context, async (transaction) => {
        if (input.parent_id !== null) {
          const parent = await transaction.category.findUnique({
            where: { storeId_id: { id: input.parent_id, storeId: request.storeId } },
          });
          if (!parent) throw new NotFoundException('Resource not found');
          if (parent.depth !== 1) throw new ConflictException('Category depth exceeds two levels');
        }
        const created = await transaction.category.create({
          data: {
            code: input.code,
            createdBy: context.actor.id,
            depth: input.parent_id === null ? 1 : 2,
            parentId: input.parent_id,
            sortOrder: input.sort_order,
            storeId: request.storeId,
            updatedBy: context.actor.id,
          },
        });
        await transaction.categoryLocalization.createMany({
          data: input.localizations.map((localization) => ({
            categoryId: created.id,
            description: localization.description,
            locale: localization.locale,
            name: localization.name,
            shareSummary: localization.share_summary,
            shareTitle: localization.share_title,
            storeId: request.storeId,
          })),
        });
        const category = await transaction.category.findUniqueOrThrow({
          include: { category_localizations: true },
          where: { storeId_id: { id: created.id, storeId: request.storeId } },
        });
        await this.admin.writeAudit(transaction, context, {
          action: 'catalog.category.created',
          after: category,
          targetId: category.id,
          targetType: 'category',
        });
        return category;
      });
    } catch (error) {
      if (isUniqueConflict(error)) throw new ConflictException('Category code already exists');
      throw error;
    }
  }

  public async updateCategory(
    request: CatalogContext,
    categoryId: string,
    input: UpdateCategoryInput,
  ) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.manage',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const before = await transaction.category.findUnique({
        include: { category_localizations: true },
        where: { storeId_id: { id: categoryId, storeId: request.storeId } },
      });
      if (!before) throw new NotFoundException('Resource not found');
      let depth = before.depth;
      if (input.parent_id !== undefined) {
        if (input.parent_id === categoryId) throw new ConflictException('Category cycle detected');
        if (input.parent_id === null) {
          depth = 1;
        } else {
          const parent = await transaction.category.findUnique({
            where: { storeId_id: { id: input.parent_id, storeId: request.storeId } },
          });
          if (!parent) throw new NotFoundException('Resource not found');
          if (parent.depth !== 1) throw new ConflictException('Category depth exceeds two levels');
          if (
            (await transaction.category.count({
              where: { parentId: categoryId, storeId: request.storeId },
            })) > 0
          ) {
            throw new ConflictException('A category with children cannot become a child');
          }
          depth = 2;
        }
      }
      const updated = await transaction.category.updateMany({
        data: {
          depth,
          parentId: input.parent_id,
          sortOrder: input.sort_order,
          status: input.status,
          updatedBy: context.actor.id,
          version: { increment: 1 },
        },
        where: { id: categoryId, storeId: request.storeId, version: input.expected_version },
      });
      if (updated.count !== 1) throw new ConflictException('Category version conflict');
      for (const localization of input.localizations ?? []) {
        await transaction.categoryLocalization.upsert({
          create: {
            categoryId,
            description: localization.description,
            locale: localization.locale,
            name: localization.name,
            shareSummary: localization.share_summary,
            shareTitle: localization.share_title,
            storeId: request.storeId,
          },
          update: {
            description: localization.description,
            name: localization.name,
            shareSummary: localization.share_summary,
            shareTitle: localization.share_title,
          },
          where: {
            storeId_categoryId_locale: {
              categoryId,
              locale: localization.locale,
              storeId: request.storeId,
            },
          },
        });
      }
      const after = await transaction.category.findUniqueOrThrow({
        include: { category_localizations: true },
        where: { storeId_id: { id: categoryId, storeId: request.storeId } },
      });
      await this.admin.writeAudit(transaction, context, {
        action: 'catalog.category.updated',
        after,
        before,
        targetId: categoryId,
        targetType: 'category',
      });
      return after;
    });
  }

  public async listAttributeTemplates(request: CatalogContext) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.read',
    );
    return withStoreTransaction(this.database, context, (transaction) =>
      transaction.attributeTemplate.findMany({
        include: {
          attribute_template_versions: {
            include: {
              attribute_definitions: { include: { attribute_options: true } },
            },
            orderBy: { version: 'desc' },
          },
        },
        orderBy: { code: 'asc' },
      }),
    );
  }

  public async bindCategoryTemplate(
    request: CatalogContext,
    categoryId: string,
    templateVersionId: string,
    input: { is_primary: boolean },
  ) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.manage',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const [category, templateVersion] = await Promise.all([
        transaction.category.findUnique({
          where: { storeId_id: { id: categoryId, storeId: request.storeId } },
        }),
        transaction.attributeTemplateVersion.findUnique({
          where: { storeId_id: { id: templateVersionId, storeId: request.storeId } },
        }),
      ]);
      if (!category || !templateVersion || templateVersion.status !== 'ACTIVE') {
        throw new NotFoundException('Resource not found');
      }
      if (input.is_primary) {
        await transaction.categoryAttributeTemplate.updateMany({
          data: { isPrimary: false },
          where: { categoryId, isPrimary: true, storeId: request.storeId },
        });
      }
      const binding = await transaction.categoryAttributeTemplate.upsert({
        create: {
          categoryId,
          createdBy: context.actor.id,
          isPrimary: input.is_primary,
          storeId: request.storeId,
          templateVersionId,
        },
        update: { isPrimary: input.is_primary },
        where: {
          storeId_categoryId_templateVersionId: {
            categoryId,
            storeId: request.storeId,
            templateVersionId,
          },
        },
      });
      await this.admin.writeAudit(transaction, context, {
        action: 'catalog.category.attribute_template.bound',
        after: binding,
        targetId: categoryId,
        targetType: 'category',
      });
      return binding;
    });
  }

  public async unbindCategoryTemplate(
    request: CatalogContext,
    categoryId: string,
    templateVersionId: string,
  ) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.manage',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const before = await transaction.categoryAttributeTemplate.findUnique({
        where: {
          storeId_categoryId_templateVersionId: {
            categoryId,
            storeId: request.storeId,
            templateVersionId,
          },
        },
      });
      if (!before) throw new NotFoundException('Resource not found');
      await transaction.categoryAttributeTemplate.delete({
        where: {
          storeId_categoryId_templateVersionId: {
            categoryId,
            storeId: request.storeId,
            templateVersionId,
          },
        },
      });
      await this.admin.writeAudit(transaction, context, {
        action: 'catalog.category.attribute_template.unbound',
        before,
        targetId: categoryId,
        targetType: 'category',
      });
      return { status: 'ok' as const };
    });
  }

  public async createAttributeTemplate(
    request: CatalogContext,
    input: CreateAttributeTemplateInput,
  ) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.manage',
    );
    try {
      return await withStoreTransaction(this.database, context, async (transaction) => {
        const store = await transaction.store.findUnique({ where: { id: request.storeId } });
        if (!store) throw new NotFoundException('Resource not found');
        const template = await transaction.attributeTemplate.create({
          data: {
            code: input.code,
            createdBy: context.actor.id,
            industry: store.industry,
            storeId: request.storeId,
            updatedBy: context.actor.id,
          },
        });
        const version = await this.createTemplateVersion(
          transaction,
          request.storeId,
          context.actor.id,
          template.id,
          1,
          input,
        );
        const after = { ...template, attribute_template_versions: [version] };
        await this.admin.writeAudit(transaction, context, {
          action: 'catalog.attribute_template.created',
          after,
          targetId: template.id,
          targetType: 'attribute_template',
        });
        return after;
      });
    } catch (error) {
      if (isUniqueConflict(error)) throw new ConflictException('Template code already exists');
      throw error;
    }
  }

  public async createAttributeTemplateVersion(
    request: CatalogContext,
    templateId: string,
    input: AttributeTemplateVersionInput,
  ) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.manage',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const template = await transaction.attributeTemplate.findUnique({
        include: { attribute_template_versions: { orderBy: { version: 'desc' }, take: 1 } },
        where: { storeId_id: { id: templateId, storeId: request.storeId } },
      });
      if (!template) throw new NotFoundException('Resource not found');
      if (template.attribute_template_versions[0]?.status === 'DRAFT') {
        throw new ConflictException('Finish the existing draft before creating another version');
      }
      const nextVersion = (template.attribute_template_versions[0]?.version ?? 0) + 1;
      const version = await this.createTemplateVersion(
        transaction,
        request.storeId,
        context.actor.id,
        templateId,
        nextVersion,
        input,
      );
      await this.admin.writeAudit(transaction, context, {
        action: 'catalog.attribute_template.version_created',
        after: version,
        targetId: version.id,
        targetType: 'attribute_template_version',
      });
      return version;
    });
  }

  public async updateAttributeTemplateVersion(
    request: CatalogContext,
    templateId: string,
    versionNumber: number,
    input: UpdateAttributeTemplateVersionInput,
  ) {
    const version = validVersion(versionNumber);
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.manage',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const template = await transaction.attributeTemplate.findUnique({
        where: { storeId_id: { id: templateId, storeId: request.storeId } },
      });
      if (!template) throw new NotFoundException('Resource not found');
      if (template.version !== input.expected_template_version) {
        throw new ConflictException('Template version conflict');
      }
      const before = await transaction.attributeTemplateVersion.findUnique({
        include: { attribute_definitions: { include: { attribute_options: true } } },
        where: {
          storeId_templateId_version: {
            storeId: request.storeId,
            templateId,
            version,
          },
        },
      });
      if (!before) throw new NotFoundException('Resource not found');
      if (before.status !== 'DRAFT')
        throw new ConflictException('Activated versions are immutable');
      const definitionIds = before.attribute_definitions.map((definition) => definition.id);
      if (definitionIds.length > 0) {
        await transaction.attributeOption.deleteMany({
          where: { attributeDefinitionId: { in: definitionIds }, storeId: request.storeId },
        });
      }
      await transaction.attributeDefinition.deleteMany({
        where: { storeId: request.storeId, templateVersionId: before.id },
      });
      await transaction.attributeTemplateVersion.update({
        data: { name: input.name },
        where: { storeId_id: { id: before.id, storeId: request.storeId } },
      });
      await this.createDefinitions(transaction, request.storeId, before.id, input.definitions);
      await transaction.attributeTemplate.update({
        data: { updatedBy: context.actor.id, version: { increment: 1 } },
        where: { storeId_id: { id: templateId, storeId: request.storeId } },
      });
      const after = await transaction.attributeTemplateVersion.findUniqueOrThrow({
        include: { attribute_definitions: { include: { attribute_options: true } } },
        where: { storeId_id: { id: before.id, storeId: request.storeId } },
      });
      await this.admin.writeAudit(transaction, context, {
        action: 'catalog.attribute_template.version_updated',
        after,
        before,
        targetId: before.id,
        targetType: 'attribute_template_version',
      });
      return after;
    });
  }

  public async activateAttributeTemplateVersion(
    request: CatalogContext,
    templateId: string,
    versionNumber: number,
    input: { expected_template_version: number },
  ) {
    const version = validVersion(versionNumber);
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.catalog.publish',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const template = await transaction.attributeTemplate.findUnique({
        where: { storeId_id: { id: templateId, storeId: request.storeId } },
      });
      if (!template) throw new NotFoundException('Resource not found');
      if (template.version !== input.expected_template_version) {
        throw new ConflictException('Template version conflict');
      }
      const draft = await transaction.attributeTemplateVersion.findUnique({
        where: {
          storeId_templateId_version: {
            storeId: request.storeId,
            templateId,
            version,
          },
        },
      });
      if (!draft) throw new NotFoundException('Resource not found');
      if (draft.status !== 'DRAFT') throw new ConflictException('Version is not a draft');
      const after = await transaction.attributeTemplateVersion.update({
        data: { activatedAt: new Date(), activatedBy: context.actor.id, status: 'ACTIVE' },
        where: { storeId_id: { id: draft.id, storeId: request.storeId } },
      });
      await transaction.attributeTemplate.update({
        data: {
          currentVersion: version,
          status: 'ACTIVE',
          updatedBy: context.actor.id,
          version: { increment: 1 },
        },
        where: { storeId_id: { id: templateId, storeId: request.storeId } },
      });
      await this.admin.writeAudit(transaction, context, {
        action: 'catalog.attribute_template.activated',
        after,
        before: draft,
        targetId: draft.id,
        targetType: 'attribute_template_version',
      });
      return after;
    });
  }

  private async createTemplateVersion(
    transaction: StoreTransaction,
    storeId: string,
    actorId: string,
    templateId: string,
    version: number,
    input: AttributeTemplateVersionInput,
  ) {
    const created = await transaction.attributeTemplateVersion.create({
      data: { createdBy: actorId, name: input.name, storeId, templateId, version },
    });
    await this.createDefinitions(transaction, storeId, created.id, input.definitions);
    return transaction.attributeTemplateVersion.findUniqueOrThrow({
      include: { attribute_definitions: { include: { attribute_options: true } } },
      where: { storeId_id: { id: created.id, storeId } },
    });
  }

  private async createDefinitions(
    transaction: StoreTransaction,
    storeId: string,
    templateVersionId: string,
    definitions: AttributeTemplateVersionInput['definitions'],
  ): Promise<void> {
    for (const definition of definitions) {
      const created = await transaction.attributeDefinition.create({
        data: {
          code: definition.code,
          dataType: definition.data_type,
          filterable: definition.filterable,
          labelEn: definition.label_en,
          labelVi: definition.label_vi,
          labelZh: definition.label_zh,
          multiple: definition.multiple,
          purpose: definition.purpose,
          required: definition.required,
          sortOrder: definition.sort_order,
          storeId,
          templateVersionId,
          unit: definition.unit,
          validationRules: definition.validation_rules as Prisma.InputJsonValue,
        },
      });
      await transaction.attributeOption.createMany({
        data: definition.options.map((option) => ({
          attributeDefinitionId: created.id,
          code: option.code,
          labelEn: option.label_en,
          labelVi: option.label_vi,
          labelZh: option.label_zh,
          sortOrder: option.sort_order,
          storeId,
        })),
      });
    }
  }
}
