import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreatePageDraftInput,
  PublishPageInput,
  ReplacePageDraftInput,
} from '@zalo-shop/contracts';
import type { Prisma, PrismaClient, StoreTransaction } from '@zalo-shop/database';
import { withStoreTransaction } from '@zalo-shop/database';
import type { RuntimeConfig } from '@zalo-shop/config';

import { AdminService, type AdminHeaders } from '../admin/admin.service';
import { DATABASE_CLIENT } from '../auth/auth.tokens';
import { RUNTIME_CONFIG } from '../health.controller';

type ContentContext = { headers: AdminHeaders; storeId: string };

const pageInclude = {
  page_versions_page_versions_store_id_page_idTopages: {
    include: {
      page_modules: {
        include: {
          page_module_localizations: true,
          page_module_media: true,
        },
        orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
      },
    },
    orderBy: { version: 'desc' as const },
  },
} satisfies Prisma.PageInclude;

type LoadedPage = Prisma.PageGetPayload<{ include: typeof pageInclude }>;

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

function viewVersion(
  version: LoadedPage['page_versions_page_versions_store_id_page_idTopages'][number],
) {
  return {
    created_at: version.createdAt.toISOString(),
    id: version.id,
    modules: version.page_modules.map((module) => ({
      background_config: module.backgroundConfig,
      id: module.id,
      localizations: module.page_module_localizations.map((localization) => ({
        button_label: localization.buttonLabel,
        content_config: localization.contentConfig,
        locale: localization.locale,
        summary: localization.summary,
        title: localization.title,
      })),
      media: module.page_module_media.map((media) => ({
        media_id: media.mediaId,
        purpose: media.purpose,
        sort_order: media.sortOrder,
      })),
      module_type: module.moduleType,
      sort_order: module.sortOrder,
      status: module.status,
      target_id: module.targetId,
      target_type: module.targetType,
      target_url: module.targetUrl,
      visible_from: module.visibleFrom?.toISOString() ?? null,
      visible_to: module.visibleTo?.toISOString() ?? null,
    })),
    publication_status: version.publicationStatus,
    published_at: version.publishedAt?.toISOString() ?? null,
    version: version.version,
  };
}

function viewPage(page: LoadedPage) {
  const versions = page.page_versions_page_versions_store_id_page_idTopages;
  const draft = versions.find(({ publicationStatus }) => publicationStatus === 'DRAFT');
  const published = versions.find(({ id }) => id === page.currentPublishedVersionId);
  return {
    code: page.code,
    draft: draft ? viewVersion(draft) : null,
    id: page.id,
    published: published ? viewVersion(published) : null,
    status: page.status,
    updated_at: page.updatedAt.toISOString(),
    version: page.version,
  };
}

@Injectable()
export class ContentAdminService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  public async listPages(request: ContentContext) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.content.read',
    );
    return withStoreTransaction(this.database, context, async (transaction) => ({
      items: (
        await transaction.page.findMany({ include: pageInclude, orderBy: { code: 'asc' } })
      ).map(viewPage),
    }));
  }

  public async createPage(request: ContentContext, input: CreatePageDraftInput) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.content.manage',
    );
    try {
      return await withStoreTransaction(this.database, context, async (transaction) => {
        const page = await transaction.page.create({
          data: {
            code: input.code,
            createdBy: context.actor.id,
            storeId: request.storeId,
            updatedBy: context.actor.id,
          },
        });
        await transaction.pageVersion.create({
          data: {
            createdBy: context.actor.id,
            pageId: page.id,
            storeId: request.storeId,
            version: 1,
          },
        });
        const after = await this.loadPage(transaction, request.storeId, page.id);
        await this.admin.writeAudit(transaction, context, {
          action: 'content.page.created',
          after: after && viewPage(after),
          targetId: page.id,
          targetType: 'page',
        });
        return viewPage(after!);
      });
    } catch (error) {
      if (isUniqueConflict(error)) throw new ConflictException('Page code already exists');
      throw error;
    }
  }

  public async replaceDraft(request: ContentContext, pageId: string, input: ReplacePageDraftInput) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.content.manage',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const before = await this.loadPage(transaction, request.storeId, pageId);
      if (!before) throw new NotFoundException('Resource not found');
      const claimed = await transaction.page.updateMany({
        data: { updatedBy: context.actor.id, version: { increment: 1 } },
        where: { id: pageId, storeId: request.storeId, version: input.expected_version },
      });
      if (claimed.count !== 1) throw new ConflictException('Page version conflict');

      await this.validateReferences(transaction, request.storeId, pageId, input, false);
      let draft = before.page_versions_page_versions_store_id_page_idTopages.find(
        ({ publicationStatus }) => publicationStatus === 'DRAFT',
      );
      if (!draft) {
        const nextVersion =
          Math.max(
            0,
            ...before.page_versions_page_versions_store_id_page_idTopages.map(({ version }) =>
              Number(version),
            ),
          ) + 1;
        draft = await transaction.pageVersion.create({
          data: {
            createdBy: context.actor.id,
            pageId,
            storeId: request.storeId,
            version: nextVersion,
          },
          include: pageInclude.page_versions_page_versions_store_id_page_idTopages.include,
        });
      } else {
        const moduleIds = draft.page_modules.map(({ id }) => id);
        if (moduleIds.length > 0) {
          await transaction.pageModuleMedia.deleteMany({
            where: { pageModuleId: { in: moduleIds }, storeId: request.storeId },
          });
          await transaction.pageModuleLocalization.deleteMany({
            where: { pageModuleId: { in: moduleIds }, storeId: request.storeId },
          });
          await transaction.pageModule.deleteMany({
            where: { id: { in: moduleIds }, storeId: request.storeId },
          });
        }
      }

      for (const module of [...input.modules].sort(
        (left, right) => left.sort_order - right.sort_order,
      )) {
        const created = await transaction.pageModule.create({
          data: {
            backgroundConfig: module.background_config,
            moduleType: module.module_type,
            pageVersionId: draft.id,
            sortOrder: module.sort_order,
            status: module.status,
            storeId: request.storeId,
            targetId: module.target_id,
            targetType: module.target_type,
            targetUrl: module.target_url,
            visibleFrom: module.visible_from,
            visibleTo: module.visible_to,
          },
        });
        await transaction.pageModuleLocalization.createMany({
          data: module.localizations.map((localization) => ({
            buttonLabel: localization.button_label,
            contentConfig: localization.content_config,
            locale: localization.locale,
            pageModuleId: created.id,
            storeId: request.storeId,
            summary: localization.summary,
            title: localization.title,
          })),
        });
        if (module.media.length > 0) {
          await transaction.pageModuleMedia.createMany({
            data: module.media.map((media) => ({
              mediaId: media.media_id,
              pageModuleId: created.id,
              purpose: media.purpose,
              sortOrder: media.sort_order,
              storeId: request.storeId,
            })),
          });
        }
      }
      const after = await this.loadPage(transaction, request.storeId, pageId);
      await this.admin.writeAudit(transaction, context, {
        action: 'content.page.draft_replaced',
        after: after && viewPage(after),
        before: viewPage(before),
        targetId: pageId,
        targetType: 'page',
      });
      return viewPage(after!);
    });
  }

  public async publishPage(request: ContentContext, pageId: string, input: PublishPageInput) {
    const context = await this.admin.authorize(
      request.headers,
      request.storeId,
      'store.content.manage',
    );
    return withStoreTransaction(this.database, context, async (transaction) => {
      const before = await this.loadPage(transaction, request.storeId, pageId);
      if (!before) throw new NotFoundException('Resource not found');
      if (input.confirmation_code !== before.code) {
        throw new ConflictException('Page publish confirmation does not match');
      }
      const draft = before.page_versions_page_versions_store_id_page_idTopages.find(
        ({ publicationStatus }) => publicationStatus === 'DRAFT',
      );
      if (!draft || draft.page_modules.length === 0) {
        throw new ConflictException('A non-empty page draft is required');
      }
      if (
        draft.page_modules.some((module) => {
          const localizations = new Map(
            module.page_module_localizations.map((item) => [item.locale, item]),
          );
          return ['vi', 'zh', 'en'].some(
            (locale) => !localizations.get(locale as 'vi' | 'zh' | 'en')?.title?.trim(),
          );
        })
      ) {
        throw new ConflictException(
          'Every page module requires Vietnamese, Chinese and English content',
        );
      }
      const claimed = await transaction.page.updateMany({
        data: {
          currentPublishedVersionId: draft.id,
          status: 'PUBLISHED',
          updatedBy: context.actor.id,
          version: { increment: 1 },
        },
        where: { id: pageId, storeId: request.storeId, version: input.expected_version },
      });
      if (claimed.count !== 1) throw new ConflictException('Page version conflict');
      await this.validateReferences(
        transaction,
        request.storeId,
        pageId,
        {
          expected_version: input.expected_version,
          modules: draft.page_modules.map((module) => ({
            background_config:
              module.backgroundConfig as ReplacePageDraftInput['modules'][number]['background_config'],
            localizations: module.page_module_localizations.map((item) => ({
              button_label: item.buttonLabel,
              content_config: item.contentConfig as Record<string, unknown>,
              locale: item.locale,
              summary: item.summary,
              title: item.title!,
            })),
            media: module.page_module_media.map((item) => ({
              media_id: item.mediaId,
              purpose: item.purpose as 'COVER' | 'GALLERY',
              sort_order: item.sortOrder,
            })),
            module_type: module.moduleType,
            sort_order: module.sortOrder,
            status: module.status,
            target_id: module.targetId,
            target_type: module.targetType,
            target_url: module.targetUrl,
            visible_from: module.visibleFrom,
            visible_to: module.visibleTo,
          })),
        },
        true,
      );
      await transaction.pageVersion.update({
        data: {
          publicationStatus: 'PUBLISHED',
          publishedAt: new Date(),
          publishedBy: context.actor.id,
        },
        where: { storeId_id: { id: draft.id, storeId: request.storeId } },
      });
      const after = await this.loadPage(transaction, request.storeId, pageId);
      await this.admin.writeAudit(transaction, context, {
        action: 'content.page.published',
        after: after && viewPage(after),
        before: viewPage(before),
        targetId: pageId,
        targetType: 'page',
      });
      return viewPage(after!);
    });
  }

  private loadPage(transaction: StoreTransaction, storeId: string, pageId: string) {
    return transaction.page.findUnique({
      include: pageInclude,
      where: { storeId_id: { id: pageId, storeId } },
    });
  }

  private async validateReferences(
    transaction: StoreTransaction,
    storeId: string,
    pageId: string,
    input: ReplacePageDraftInput,
    publishing: boolean,
  ): Promise<void> {
    const mediaIds = input.modules.flatMap(({ media }) => media.map(({ media_id }) => media_id));
    if (new Set(mediaIds).size !== mediaIds.length) {
      throw new ConflictException('Page media associations must be unique');
    }
    if (mediaIds.length > 0) {
      const media = await transaction.mediaAsset.findMany({
        where: { id: { in: mediaIds }, storeId },
      });
      if (
        media.length !== mediaIds.length ||
        media.some(
          (item) => item.status !== 'READY' || !item.objectKey.includes(`/${storeId}/page/`),
        )
      ) {
        throw new ConflictException('Page media must be ready page resources from this store');
      }
    }

    for (const module of input.modules) {
      if (module.target_type === 'EXTERNAL') {
        const host = new URL(module.target_url!).hostname.toLowerCase();
        if (!this.config.CONTENT_EXTERNAL_TARGET_HOSTS.includes(host)) {
          throw new ConflictException('External target host is not allowed');
        }
      } else if (module.target_type && module.target_id) {
        const active = await this.internalTargetExists(
          transaction,
          storeId,
          pageId,
          module.target_type,
          module.target_id,
          publishing,
        );
        if (!active) throw new NotFoundException('Resource not found');
      }
    }
  }

  private async internalTargetExists(
    transaction: StoreTransaction,
    storeId: string,
    pageId: string,
    targetType: Exclude<ReplacePageDraftInput['modules'][number]['target_type'], 'EXTERNAL' | null>,
    targetId: string,
    publishing: boolean,
  ): Promise<boolean> {
    if (targetType === 'PRODUCT') {
      return Boolean(
        await transaction.product.findFirst({
          where: {
            deletedAt: null,
            enabled: publishing ? true : undefined,
            id: targetId,
            status: publishing ? 'PUBLISHED' : undefined,
            storeId,
          },
        }),
      );
    }
    if (targetType === 'BRAND') {
      return Boolean(
        await transaction.brand.findFirst({
          where: {
            deletedAt: null,
            id: targetId,
            status: publishing ? 'ACTIVE' : undefined,
            storeId,
          },
        }),
      );
    }
    if (targetType === 'CATEGORY') {
      return Boolean(
        await transaction.category.findFirst({
          where: {
            deletedAt: null,
            id: targetId,
            status: publishing ? 'ACTIVE' : undefined,
            storeId,
          },
        }),
      );
    }
    if (targetId === pageId) return false;
    return Boolean(
      await transaction.page.findFirst({
        where: { id: targetId, status: publishing ? 'PUBLISHED' : undefined, storeId },
      }),
    );
  }
}
