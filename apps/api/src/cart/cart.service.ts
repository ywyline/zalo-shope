import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import type { SetCartItemInput, UpdateCartItemInput } from '@zalo-shop/contracts';
import {
  Prisma,
  type Locale,
  type PrismaClient,
  type StoreTransaction,
  withStoreTransaction,
} from '@zalo-shop/database';
import {
  assessCartLine,
  CartRuleError,
  createStoreContext,
  type CartLineAssessment,
} from '@zalo-shop/domain';
import type { MediaStorageProvider } from '@zalo-shop/integrations';

import { AuthService } from '../auth/auth.service';
import { DATABASE_CLIENT, MEDIA_STORAGE_PROVIDER } from '../auth/auth.tokens';
import { PricingService } from '../pricing/pricing.service';

type ResolvedStore = { code: string; default_locale: Locale; id: string };
type PricingQuote = Awaited<ReturnType<PricingService['quoteMerchandise']>>;
const MAX_INVENTORY_QUANTITY = 2_147_483_647;

/**
 * Keep the include in one place.  Besides making the cart response useful to
 * the Mini App, loading the catalogue facts with the cart prevents a second
 * non-transactional lookup from accidentally crossing a store boundary.
 */
const cartInclude = {
  items: {
    include: {
      sku: {
        include: {
          inventoryBalances: {
            include: { warehouse: true },
            where: { warehouse: { enabled: true, isDefaultFulfillment: true } },
          },
          products: {
            include: {
              brands: { include: { brand_localizations: true } },
              categories: true,
              product_localizations: true,
              product_media: {
                include: { media_assets: true },
                orderBy: [{ sortOrder: 'asc' as const }, { mediaId: 'asc' as const }],
              },
              skus: {
                include: {
                  sku_media: {
                    include: { media_assets: true },
                    orderBy: [{ sortOrder: 'asc' as const }, { mediaId: 'asc' as const }],
                  },
                  sku_option_values: {
                    include: { attribute_definitions: true, attribute_options: true },
                    orderBy: { attributeDefinitionId: 'asc' as const },
                  },
                },
                orderBy: { code: 'asc' as const },
                where: { status: 'ACTIVE' as const },
              },
            },
          },
          sku_media: {
            include: { media_assets: true },
            orderBy: [{ sortOrder: 'asc' as const }, { mediaId: 'asc' as const }],
          },
          sku_option_values: {
            include: { attribute_definitions: true, attribute_options: true },
            orderBy: { attributeDefinitionId: 'asc' as const },
          },
        },
      },
    },
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
  },
} satisfies Prisma.CartInclude;

type LoadedCart = Prisma.CartGetPayload<{ include: typeof cartInclude }>;
type LoadedCartItem = LoadedCart['items'][number];

type CartLineView = {
  assessment: CartLineAssessment;
  item: LoadedCartItem;
  currentUnitPriceVnd: number;
  availableQuantity: number;
  quoteLine: PricingQuote['lines'][number] | undefined;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function safeVnd(value: bigint | number): number {
  const amount = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new BadRequestException('Quoted amount exceeds the supported VND range');
  }
  return amount;
}

function safeQuantity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_INVENTORY_QUANTITY) {
    throw new BadRequestException('Inventory quantity is invalid');
  }
  return value;
}

function localized<T extends { locale: Locale }>(
  values: readonly T[],
  locale: Locale,
): { value: T | undefined; resolved: Locale } {
  const direct = values.find((value) => value.locale === locale);
  const vi = values.find((value) => value.locale === 'vi');
  const first = values[0];
  return {
    resolved: direct ? locale : vi ? 'vi' : (first?.locale ?? 'vi'),
    value: direct ?? vi ?? first,
  };
}

function localizedLabel(
  value: { labelEn: string | null; labelVi: string; labelZh: string | null },
  locale: Locale,
): string {
  return (
    (locale === 'en' ? value.labelEn : locale === 'zh' ? value.labelZh : value.labelVi) ??
    value.labelVi
  );
}

export function promotionFingerprint(quote: PricingQuote, skuCode: string): string {
  const line = quote.lines.find((candidate) => candidate.sku_code === skuCode);
  // Amounts and quoted_at intentionally do not participate.  A quantity
  // change can legitimately change a discount amount without changing the
  // promotion version; the cart should report a promotion change only when
  // the applicable rule facts/eligibility changed.
  const applied = (line?.applied_rules ?? [])
    .map(({ bucket, code, version_id }) => ({ bucket, code, version_id }))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), 'en'));
  const rejected = (line?.rejected_rules ?? [])
    // A promotion targeted at another SKU is not a change for this line.  It
    // is represented as TARGET_MISMATCH by the pricing engine; excluding it
    // avoids noisy PROMOTION_CHANGED messages whenever an unrelated campaign
    // is published in the same store.
    .filter(({ reason }) => reason !== 'TARGET_MISMATCH')
    .map(({ bucket, code, reason, version_id }) => ({ bucket, code, reason, version_id }))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), 'en'));
  return sha256({ applied, rejected });
}

function isKnownPrismaError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function isProductPublished(item: LoadedCartItem): boolean {
  const product = item.sku.products;
  return (
    product.enabled &&
    product.deletedAt === null &&
    product.status === 'PUBLISHED' &&
    product.brands.status === 'ACTIVE' &&
    product.brands.deletedAt === null &&
    product.categories.status === 'ACTIVE' &&
    product.categories.deletedAt === null
  );
}

function availableQuantity(item: LoadedCartItem): number {
  const total = item.sku.inventoryBalances.reduce(
    (sum, balance) => sum + BigInt(balance.available),
    0n,
  );
  if (total > BigInt(MAX_INVENTORY_QUANTITY)) {
    throw new BadRequestException('Inventory quantity is invalid');
  }
  return safeQuantity(Number(total));
}

@Injectable()
export class CartService {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PricingService) private readonly pricing: PricingService,
    @Optional()
    @Inject(MEDIA_STORAGE_PROVIDER)
    private readonly mediaStorage?: MediaStorageProvider,
  ) {}

  public async get(input: {
    authorization: string | undefined;
    locale: Locale;
    storeCode: string;
  }) {
    const member = await this.memberContext(input.authorization, input.storeCode, input.locale);
    return this.withRetry(() =>
      withStoreTransaction(
        this.database,
        member.context,
        async (transaction) => {
          const cart = await this.ensureCart(transaction, member.store.id, member.memberId);
          return this.renderCart(
            transaction,
            cart.id,
            member.store.id,
            member.memberId,
            input.locale,
          );
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      ),
    );
  }

  public async setItem(input: {
    authorization: string | undefined;
    locale: Locale;
    request: SetCartItemInput;
    skuCode: string;
    storeCode: string;
  }) {
    const member = await this.memberContext(input.authorization, input.storeCode, input.locale);
    return this.withRetry(() =>
      withStoreTransaction(
        this.database,
        member.context,
        async (transaction) => {
          const sku = await this.findSku(transaction, member.store.id, input.skuCode);
          const cart = await this.ensureCart(transaction, member.store.id, member.memberId);
          await this.lockCart(transaction, member.store.id, cart.id);
          const existing = await transaction.cartItem.findUnique({
            where: {
              storeId_cartId_skuId: {
                cartId: cart.id,
                skuId: sku.id,
                storeId: member.store.id,
              },
            },
          });

          if (!existing) {
            const snapshot = await this.captureSnapshot(
              transaction,
              member.store.id,
              member.memberId,
              input.skuCode,
              input.request.quantity,
              input.locale,
            );
            await transaction.cartItem.create({
              data: {
                addedPromotionFingerprint: snapshot.promotionFingerprint,
                addedUnitPriceVnd: BigInt(snapshot.unitPriceVnd),
                cartId: cart.id,
                quantity: input.request.quantity,
                selected: input.request.selected,
                skuId: sku.id,
                storeId: member.store.id,
              },
            });
            await this.bumpCart(transaction, member.store.id, cart.id);
          } else if (
            existing.quantity !== input.request.quantity ||
            existing.selected !== input.request.selected
          ) {
            await transaction.cartItem.update({
              data: {
                quantity: input.request.quantity,
                selected: input.request.selected,
                version: { increment: 1 },
              },
              where: { storeId_id: { id: existing.id, storeId: member.store.id } },
            });
            await this.bumpCart(transaction, member.store.id, cart.id);
          }
          return this.renderCart(
            transaction,
            cart.id,
            member.store.id,
            member.memberId,
            input.locale,
          );
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      ),
    );
  }

  public async updateItem(input: {
    authorization: string | undefined;
    itemId: string;
    locale: Locale;
    request: UpdateCartItemInput;
    storeCode: string;
  }) {
    const member = await this.memberContext(input.authorization, input.storeCode, input.locale);
    return this.withRetry(() =>
      withStoreTransaction(
        this.database,
        member.context,
        async (transaction) => {
          const cart = await this.findCart(transaction, member.store.id, member.memberId);
          if (!cart) throw new NotFoundException('Cart not found');
          await this.lockCart(transaction, member.store.id, cart.id);
          const item = await transaction.cartItem.findFirst({
            where: { cartId: cart.id, id: input.itemId, storeId: member.store.id },
          });
          if (!item) throw new NotFoundException('Cart item not found');
          if (item.version !== input.request.expected_version) {
            throw new ConflictException('VERSION_CONFLICT');
          }

          let replacementSkuId: string | undefined;
          let replacementSnapshot:
            { promotionFingerprint: string; unitPriceVnd: number } | undefined;
          if (input.request.replacement_sku_code !== undefined) {
            const replacement = await this.findSku(
              transaction,
              member.store.id,
              input.request.replacement_sku_code,
            );
            const currentSku = await transaction.sku.findUnique({
              select: { productId: true },
              where: { storeId_id: { id: item.skuId, storeId: member.store.id } },
            });
            if (!currentSku) throw new NotFoundException('Cart item not found');
            if (currentSku.productId !== replacement.productId) {
              throw new ConflictException('CART_LINE_CONFLICT');
            }
            if (replacement.id !== item.skuId) {
              const occupied = await transaction.cartItem.findUnique({
                select: { id: true },
                where: {
                  storeId_cartId_skuId: {
                    cartId: cart.id,
                    skuId: replacement.id,
                    storeId: member.store.id,
                  },
                },
              });
              if (occupied) throw new ConflictException('CART_LINE_CONFLICT');
              replacementSkuId = replacement.id;
              replacementSnapshot = await this.captureSnapshot(
                transaction,
                member.store.id,
                member.memberId,
                replacement.code,
                input.request.quantity ?? item.quantity,
                input.locale,
              );
            }
          }

          const changed =
            input.request.quantity !== undefined && input.request.quantity !== item.quantity;
          const selectedChanged =
            input.request.selected !== undefined && input.request.selected !== item.selected;
          const skuChanged = replacementSkuId !== undefined;
          if (changed || selectedChanged || skuChanged) {
            await transaction.cartItem.update({
              data: {
                ...(changed ? { quantity: input.request.quantity } : {}),
                ...(selectedChanged ? { selected: input.request.selected } : {}),
                ...(skuChanged
                  ? {
                      addedPromotionFingerprint: replacementSnapshot!.promotionFingerprint,
                      addedUnitPriceVnd: BigInt(replacementSnapshot!.unitPriceVnd),
                      skuId: replacementSkuId,
                    }
                  : {}),
                version: { increment: 1 },
              },
              where: { storeId_id: { id: item.id, storeId: member.store.id } },
            });
            await this.bumpCart(transaction, member.store.id, cart.id);
          }
          return this.renderCart(
            transaction,
            cart.id,
            member.store.id,
            member.memberId,
            input.locale,
          );
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      ),
    );
  }

  public async deleteItem(input: {
    authorization: string | undefined;
    expectedVersion: number;
    itemId: string;
    locale: Locale;
    storeCode: string;
  }): Promise<void> {
    const member = await this.memberContext(input.authorization, input.storeCode, input.locale);
    await this.withRetry(() =>
      withStoreTransaction(
        this.database,
        member.context,
        async (transaction) => {
          const cart = await this.findCart(transaction, member.store.id, member.memberId);
          if (!cart) throw new NotFoundException('Cart not found');
          await this.lockCart(transaction, member.store.id, cart.id);
          const item = await transaction.cartItem.findFirst({
            where: { cartId: cart.id, id: input.itemId, storeId: member.store.id },
            select: { id: true, version: true },
          });
          if (!item) throw new NotFoundException('Cart item not found');
          if (item.version !== input.expectedVersion) {
            throw new ConflictException('VERSION_CONFLICT');
          }
          await transaction.cartItem.delete({
            where: { storeId_id: { id: item.id, storeId: member.store.id } },
          });
          await this.bumpCart(transaction, member.store.id, cart.id);
          // DELETE has a 204 response, but still re-evaluate the remaining
          // cart in the same trusted snapshot so a write never skips the
          // catalogue/availability/pricing reload required by M3.6.
          await this.renderCart(
            transaction,
            cart.id,
            member.store.id,
            member.memberId,
            input.locale,
          );
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      ),
    );
  }

  private async memberContext(
    authorization: string | undefined,
    storeCode: string,
    locale: Locale,
  ) {
    if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
      throw new UnauthorizedException('Member authentication is required');
    }
    const claims = await this.auth.authenticateAccessToken(authorization.slice(7), storeCode);
    if (claims.actorType !== 'member' || !claims.storeId) {
      throw new UnauthorizedException('Member authentication is required');
    }
    const stores = await this.database.$queryRaw<ResolvedStore[]>`
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
        locale,
        storeCode: store.code,
        storeId: store.id,
      }),
      memberId: claims.subjectId,
      store,
    };
  }

  private async ensureCart(
    transaction: StoreTransaction,
    storeId: string,
    memberId: string,
  ): Promise<{ id: string; version: number }> {
    // Locking the member row serializes first-cart creation.  The unique
    // partial index remains the final database invariant for concurrent calls.
    const member = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM members
      WHERE store_id = ${storeId}::uuid AND id = ${memberId}::uuid
      FOR UPDATE
    `;
    if (!member[0]) throw new UnauthorizedException('Member authentication is required');
    const existing = await transaction.cart.findFirst({
      select: { id: true, version: true },
      where: { memberId, status: 'ACTIVE', storeId },
    });
    if (existing) return existing;
    return transaction.cart.create({ data: { memberId, storeId } });
  }

  private findCart(transaction: StoreTransaction, storeId: string, memberId: string) {
    return transaction.cart.findFirst({
      select: { id: true, version: true },
      where: { memberId, status: 'ACTIVE', storeId },
    });
  }

  private async lockCart(transaction: StoreTransaction, storeId: string, cartId: string) {
    const locked = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM carts
      WHERE store_id = ${storeId}::uuid AND id = ${cartId}::uuid AND status = 'ACTIVE'
      FOR UPDATE
    `;
    if (!locked[0]) throw new NotFoundException('Cart not found');
  }

  private async bumpCart(transaction: StoreTransaction, storeId: string, cartId: string) {
    await transaction.cart.update({
      data: { version: { increment: 1 } },
      where: { storeId_id: { id: cartId, storeId } },
    });
  }

  private async findSku(transaction: StoreTransaction, storeId: string, skuCode: string) {
    const sku = await transaction.sku.findFirst({
      select: { id: true, code: true, productId: true },
      where: { code: skuCode, storeId },
    });
    if (!sku) throw new NotFoundException('SKU not found');
    return sku;
  }

  private async captureSnapshot(
    transaction: StoreTransaction,
    storeId: string,
    memberId: string,
    skuCode: string,
    quantity: number,
    locale: Locale,
  ) {
    const quote = await this.pricing.quoteMerchandise(transaction, {
      adminPreview: false,
      member: { id: memberId, storeId },
      request: { coupon_code: null, items: [{ quantity, sku_code: skuCode }], locale },
      storeId,
    });
    const line = quote.lines.find((candidate) => candidate.sku_code === skuCode);
    if (!line) throw new NotFoundException('SKU not found');
    return {
      promotionFingerprint: promotionFingerprint(quote, skuCode),
      unitPriceVnd: safeVnd(line.base_unit_price_vnd),
    };
  }

  private async renderCart(
    transaction: StoreTransaction,
    cartId: string,
    storeId: string,
    memberId: string,
    locale: Locale,
  ) {
    const cart = await transaction.cart.findFirst({
      include: cartInclude,
      where: { id: cartId, memberId, status: 'ACTIVE', storeId },
    });
    if (!cart) throw new NotFoundException('Cart not found');
    if (cart.items.length === 0) {
      return { blocking: false, id: cart.id, items: [], quote: null, version: cart.version };
    }

    const allQuote = await this.pricing.quoteMerchandise(transaction, {
      adminPreview: false,
      member: { id: memberId, storeId },
      request: {
        coupon_code: null,
        items: cart.items.map((item) => ({ quantity: item.quantity, sku_code: item.sku.code })),
        locale,
      },
      storeId,
    });
    const quoteLines = new Map(allQuote.lines.map((line) => [line.sku_code, line]));
    const views: CartLineView[] = cart.items.map((item) => {
      const quoteLine = quoteLines.get(item.sku.code);
      const currentUnitPriceVnd = safeVnd(quoteLine?.base_unit_price_vnd ?? item.sku.salePriceVnd);
      const available = availableQuantity(item);
      const currentPromotionFingerprint = promotionFingerprint(allQuote, item.sku.code);
      let assessment: CartLineAssessment;
      try {
        assessment = assessCartLine({
          addedPromotionFingerprint: item.addedPromotionFingerprint ?? undefined,
          addedUnitPriceVnd: safeVnd(item.addedUnitPriceVnd),
          availableStock: available,
          currentPromotionFingerprint,
          currentUnitPriceVnd,
          productPublished: isProductPublished(item),
          quantity: item.quantity,
          skuEnabled: item.sku.status === 'ACTIVE',
        });
      } catch (error) {
        if (error instanceof CartRuleError) throw new BadRequestException('Cart line is invalid');
        throw error;
      }
      return {
        assessment,
        availableQuantity: available,
        currentUnitPriceVnd,
        item,
        quoteLine,
      };
    });

    const selected = views.filter(({ assessment, item }) => item.selected && !assessment.blocking);
    const selectedQuote =
      selected.length > 0
        ? await this.pricing.quoteMerchandise(transaction, {
            adminPreview: false,
            member: { id: memberId, storeId },
            request: {
              coupon_code: null,
              items: selected.map(({ item }) => ({
                quantity: item.quantity,
                sku_code: item.sku.code,
              })),
              locale,
            },
            storeId,
          })
        : null;

    const items = await Promise.all(
      views.map(async ({ assessment, availableQuantity: available, currentUnitPriceVnd, item }) =>
        this.viewCartItem(item, assessment, available, currentUnitPriceVnd, locale),
      ),
    );
    return {
      blocking: views.some(({ assessment }) => assessment.blocking),
      id: cart.id,
      items,
      quote: selectedQuote,
      version: cart.version,
    };
  }

  private async viewCartItem(
    item: LoadedCartItem,
    assessment: CartLineAssessment,
    available: number,
    currentUnitPriceVnd: number,
    locale: Locale,
  ) {
    const productLocalized = localized(item.sku.products.product_localizations, locale);
    const productPrimary = item.sku.products.product_media.find(
      ({ purpose, media_assets: media }) => purpose === 'PRIMARY' && media.status === 'READY',
    );
    const skuMedia = item.sku.sku_media.find(({ media_assets: media }) => media.status === 'READY');
    const [primaryMedia, selectedMedia] = await Promise.all([
      this.viewMedia(
        productPrimary?.media_assets,
        locale,
        productLocalized.value?.name ?? item.sku.products.code,
      ),
      this.viewMedia(
        skuMedia?.media_assets,
        locale,
        productLocalized.value?.name ?? item.sku.products.code,
      ),
    ]);
    const optionValues = (sku: LoadedCartItem['sku']) =>
      sku.sku_option_values.map((value) => ({
        attribute_code: value.attribute_definitions.code,
        attribute_label: localizedLabel(value.attribute_definitions, locale),
        option_code: value.attribute_options.code,
        option_label: localizedLabel(value.attribute_options, locale),
      }));
    return {
      added_unit_price_vnd: safeVnd(item.addedUnitPriceVnd),
      available_quantity: available,
      current_subtotal_vnd: assessment.currentSubtotalVnd,
      current_unit_price_vnd: currentUnitPriceVnd,
      id: item.id,
      issues: assessment.issues,
      product: {
        available_skus: item.sku.products.skus.map((sku) => ({
          code: sku.code,
          option_values: optionValues(sku as LoadedCartItem['sku']),
        })),
        code: item.sku.products.code,
        name: productLocalized.value?.name ?? item.sku.products.code,
        primary_media: primaryMedia,
        requested_locale: locale,
        resolved_locale: productLocalized.resolved,
      },
      quantity: item.quantity,
      selected: item.selected,
      sku: {
        code: item.sku.code,
        media: selectedMedia,
        option_values: optionValues(item.sku),
      },
      sku_code: item.sku.code,
      version: item.version,
    };
  }

  private async viewMedia(
    media: LoadedCartItem['sku']['sku_media'][number]['media_assets'] | undefined,
    locale: Locale,
    fallbackAlt: string,
  ) {
    if (!media || media.status !== 'READY' || !this.mediaStorage) return null;
    try {
      const signed = await this.mediaStorage.createReadUrl(media.objectKey);
      return {
        alt_text:
          (locale === 'en'
            ? media.altTextEn
            : locale === 'zh'
              ? media.altTextZh
              : media.altTextVi) ??
          media.altTextVi ??
          fallbackAlt,
        expires_at: signed.expiresAt.toISOString(),
        height: media.height,
        url: signed.url,
        width: media.width,
      };
    } catch {
      // A signed URL is presentation data, not a cart fact.  If object storage
      // is temporarily unavailable the cart remains usable and the UI can
      // fall back to the product detail endpoint.
      return null;
    }
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= 2 && !isKnownPrismaError(error, 'P2034')) throw this.mapPrismaError(error);
        if (isKnownPrismaError(error, 'P2034')) {
          if (attempt >= 2) throw this.mapPrismaError(error);
          continue;
        }
        if (isKnownPrismaError(error, 'P2002')) {
          // A concurrent first-cart creation or same-SKU insert can race the
          // partial/compound unique indexes while the winner still holds its
          // row lock. Replay the whole transaction; a real occupied-SKU
          // replacement remains a stable conflict after the retry budget.
          if (attempt < 2) continue;
          throw this.mapPrismaError(error);
        }
        throw error instanceof Error ? error : new Error('Cart transaction failed');
      }
    }
  }

  private mapPrismaError(error: unknown): Error {
    if (isKnownPrismaError(error, 'P2002')) return new ConflictException('CART_LINE_CONFLICT');
    if (isKnownPrismaError(error, 'P2034')) return new ConflictException('VERSION_CONFLICT');
    if (error instanceof Error) return error;
    return new Error('Cart transaction failed');
  }
}
