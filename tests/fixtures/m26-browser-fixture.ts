import { createHash, randomUUID } from 'node:crypto';
import { parseRuntimeConfig } from '@zalo-shop/config';
import {
  adjustInventory,
  PrismaClient,
  rebuildStoreSearchProjection,
  withStoreTransaction,
} from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import { S3MediaStorageProvider } from '@zalo-shop/integrations';

const ACTOR_ID = '26000000-0000-4000-8000-000000000001';

const stores = [
  {
    brandId: '26010000-0000-4000-8000-000000000001',
    categoryId: '12000000-0000-4000-8000-000000000001',
    colors: ['#f3b7ae', '#c8676d', '#71383f'],
    definitionId: '26090000-0000-4000-8000-000000000001',
    defaultOptionId: '26091000-0000-4000-8000-000000000001',
    extraOptionId: '26080000-0000-4000-8000-000000000001',
    extraOptionLabels: { en: 'Rose', vi: 'Hồng', zh: '玫瑰色' },
    id: '10000000-0000-4000-8000-000000000001',
    industry: 'BEAUTY' as const,
    mediaIds: [
      '26030000-0000-4000-8000-000000000001',
      '26030000-0000-4000-8000-000000000002',
      '26030000-0000-4000-8000-000000000003',
      '26030000-0000-4000-8000-000000000004',
      '26030000-0000-4000-8000-000000000005',
    ],
    optionCode: 'rose',
    pageId: '26050000-0000-4000-8000-000000000001',
    pageModuleIds: [
      '26070000-0000-4000-8000-000000000001',
      '26070000-0000-4000-8000-000000000002',
      '26070000-0000-4000-8000-000000000003',
      '26070000-0000-4000-8000-000000000004',
    ],
    pageVersionId: '26060000-0000-4000-8000-000000000001',
    productIds: ['26020000-0000-4000-8000-000000000001', '26020000-0000-4000-8000-000000000002'],
    skuIds: [
      '26040000-0000-4000-8000-000000000001',
      '26040000-0000-4000-8000-000000000002',
      '26040000-0000-4000-8000-000000000003',
    ],
    storeCode: 'beauty-local',
    templateId: '26092000-0000-4000-8000-000000000001',
    templateVersionId: '26093000-0000-4000-8000-000000000001',
    translations: {
      brand: { en: 'Lumière Lab', vi: 'Lumière Lab', zh: '微光实验室' },
      brandIntro: {
        en: 'Gentle rituals shaped for modern Vietnamese skin.',
        vi: 'Nghi thức dịu nhẹ dành cho làn da Việt hiện đại.',
        zh: '为现代越南肌肤打造的温和护理仪式。',
      },
      hero: { en: 'Glow, softly', vi: 'Rạng rỡ thật dịu dàng', zh: '温柔焕亮' },
      heroSummary: {
        en: 'A considered edit of skin-first beauty essentials.',
        vi: 'Tuyển chọn tinh gọn cho làn da được nâng niu.',
        zh: '为肌肤精心挑选的轻盈日常。',
      },
      productNames: [
        { en: 'Dew Renewal Serum', vi: 'Tinh chất Sương Mai', zh: '晨露焕新精华' },
        { en: 'Velvet Petal Tint', vi: 'Son cánh hoa nhung', zh: '柔雾花瓣唇釉' },
      ],
      productPoints: [
        { en: 'Hydrating · Calm', vi: 'Cấp ẩm · Dịu da', zh: '补水 · 舒缓' },
        { en: 'Soft matte · Lasting', vi: 'Lì mịn · Bền màu', zh: '柔雾 · 持色' },
      ],
    },
  },
  {
    brandId: '26010000-0000-4000-8000-000000000002',
    categoryId: '12000000-0000-4000-8000-000000000002',
    colors: ['#d8c8b8', '#897363', '#302a27'],
    definitionId: '26090000-0000-4000-8000-000000000002',
    defaultOptionId: '26091000-0000-4000-8000-000000000002',
    extraOptionId: '26080000-0000-4000-8000-000000000002',
    extraOptionLabels: { en: 'L', vi: 'L', zh: 'L' },
    id: '10000000-0000-4000-8000-000000000002',
    industry: 'FASHION' as const,
    mediaIds: [
      '26030000-0000-4000-8000-000000000011',
      '26030000-0000-4000-8000-000000000012',
      '26030000-0000-4000-8000-000000000013',
      '26030000-0000-4000-8000-000000000014',
      '26030000-0000-4000-8000-000000000015',
    ],
    optionCode: 'l',
    pageId: '26050000-0000-4000-8000-000000000002',
    pageModuleIds: [
      '26070000-0000-4000-8000-000000000011',
      '26070000-0000-4000-8000-000000000012',
      '26070000-0000-4000-8000-000000000013',
      '26070000-0000-4000-8000-000000000014',
    ],
    pageVersionId: '26060000-0000-4000-8000-000000000002',
    productIds: ['26020000-0000-4000-8000-000000000011', '26020000-0000-4000-8000-000000000012'],
    skuIds: [
      '26040000-0000-4000-8000-000000000011',
      '26040000-0000-4000-8000-000000000012',
      '26040000-0000-4000-8000-000000000013',
    ],
    storeCode: 'fashion-local',
    templateId: '26092000-0000-4000-8000-000000000002',
    templateVersionId: '26093000-0000-4000-8000-000000000002',
    translations: {
      brand: { en: 'Forme Studio', vi: 'Forme Studio', zh: '廓形工作室' },
      brandIntro: {
        en: 'Quiet tailoring for movement through the city.',
        vi: 'Phom dáng tinh gọn cho nhịp sống thành thị.',
        zh: '为城市日常打造的简洁廓形。',
      },
      hero: { en: 'The new ease', vi: 'Thanh lịch thật tự nhiên', zh: '自在新廓形' },
      heroSummary: {
        en: 'Clean lines, tactile fabrics and an effortless rhythm.',
        vi: 'Đường nét gọn gàng, chất liệu giàu cảm xúc.',
        zh: '利落线条、质感面料与松弛节奏。',
      },
      productNames: [
        { en: 'Air Linen Shirt', vi: 'Sơ mi linen thoáng nhẹ', zh: '轻盈亚麻衬衫' },
        { en: 'Column Day Dress', vi: 'Đầm suông ban ngày', zh: '日常直筒连衣裙' },
      ],
      productPoints: [
        { en: 'Relaxed · Breathable', vi: 'Thoải mái · Thoáng khí', zh: '舒适 · 透气' },
        { en: 'Fluid · Minimal', vi: 'Mềm rủ · Tối giản', zh: '垂顺 · 极简' },
      ],
    },
  },
] as const;

type StoreFixture = (typeof stores)[number];
type FixtureLocale = 'en' | 'vi' | 'zh';

const runtimeConfig = parseRuntimeConfig();
if (!['development', 'test'].includes(runtimeConfig.NODE_ENV)) {
  throw new Error('M2.6 browser fixtures are restricted to local/test environments');
}
const database = new PrismaClient({ datasourceUrl: runtimeConfig.DATABASE_URL });
const storage = new S3MediaStorageProvider(runtimeConfig);

function svg(title: string, colors: readonly string[], wide: boolean): string {
  const width = wide ? 1600 : 900;
  const height = wide ? 1000 : 1100;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${colors[0]}"/><stop offset=".55" stop-color="${colors[1]}"/><stop offset="1" stop-color="${colors[2]}"/></linearGradient><filter id="s"><feDropShadow dx="0" dy="30" stdDeviation="30" flood-opacity=".18"/></filter></defs>
  <rect width="100%" height="100%" fill="url(#g)"/><circle cx="${width * 0.18}" cy="${height * 0.2}" r="${width * 0.18}" fill="#fff" opacity=".13"/><circle cx="${width * 0.82}" cy="${height * 0.78}" r="${width * 0.25}" fill="#fff" opacity=".08"/>
  <g filter="url(#s)"><rect x="${width * 0.36}" y="${height * 0.2}" width="${width * 0.28}" height="${height * 0.5}" rx="${width * 0.08}" fill="#fff" opacity=".82"/><rect x="${width * 0.43}" y="${height * 0.12}" width="${width * 0.14}" height="${height * 0.16}" rx="${width * 0.035}" fill="#f7eee8" opacity=".92"/><path d="M${width * 0.4} ${height * 0.55} Q${width * 0.5} ${height * 0.42} ${width * 0.6} ${height * 0.55} Q${width * 0.5} ${height * 0.68} ${width * 0.4} ${height * 0.55}" fill="${colors[1]}" opacity=".72"/></g>
  <text x="${width * 0.08}" y="${height * 0.9}" fill="#fff" font-family="Georgia,serif" font-size="${wide ? 82 : 54}" font-weight="600">${title}</text></svg>`;
}

async function uploadMedia(store: StoreFixture): Promise<void> {
  const resources = ['page', 'category', 'brand', 'product', 'product'] as const;
  const titles = [
    store.translations.hero.en,
    store.industry === 'BEAUTY' ? 'Beauty edit' : 'Fashion edit',
    store.translations.brand.en,
    store.translations.productNames[0].en,
    store.translations.productNames[1].en,
  ];
  for (const [index, id] of store.mediaIds.entries()) {
    const body = Buffer.from(svg(titles[index]!, store.colors, index === 0), 'utf8');
    const checksum = createHash('sha256').update(body).digest('hex');
    const objectKey = `test/${store.id}/${resources[index]}/${id}`;
    const target = await storage.createUploadTarget({
      byteSize: body.length,
      checksumSha256: checksum,
      contentType: 'image/svg+xml',
      objectKey,
    });
    const response = await fetch(target.url, { body, headers: target.headers, method: 'PUT' });
    if (!response.ok) throw new Error(`Browser fixture media upload failed: ${response.status}`);
    await database.mediaAsset.create({
      data: {
        altTextEn: titles[index],
        altTextVi: titles[index],
        altTextZh: titles[index],
        byteSize: body.length,
        checksumSha256: checksum,
        height: index === 0 ? 1000 : 1100,
        id,
        mimeType: 'image/svg+xml',
        objectKey,
        originalFilename: `m26-${resources[index]}-${index}.svg`,
        status: 'READY',
        storeId: store.id,
        width: index === 0 ? 1600 : 900,
      },
    });
  }
}

async function seedStore(store: StoreFixture): Promise<void> {
  await uploadMedia(store);
  await database.attributeTemplate.create({
    data: {
      code: `m26-browser-${store.industry.toLowerCase()}`,
      createdBy: ACTOR_ID,
      id: store.templateId,
      industry: store.industry,
      storeId: store.id,
    },
  });
  await database.attributeTemplateVersion.create({
    data: {
      createdBy: ACTOR_ID,
      id: store.templateVersionId,
      name: `M2.6 browser ${store.industry.toLowerCase()} v1`,
      storeId: store.id,
      templateId: store.templateId,
      version: 1,
    },
  });
  await database.attributeDefinition.create({
    data: {
      code: store.industry === 'BEAUTY' ? 'shade' : 'size',
      dataType: 'OPTION',
      filterable: true,
      id: store.definitionId,
      labelEn: store.industry === 'BEAUTY' ? 'Shade' : 'Size',
      labelVi: store.industry === 'BEAUTY' ? 'Tông màu' : 'Kích cỡ',
      labelZh: store.industry === 'BEAUTY' ? '色号' : '尺码',
      purpose: 'SPECIFICATION',
      required: true,
      storeId: store.id,
      templateVersionId: store.templateVersionId,
    },
  });
  await database.attributeOption.createMany({
    data: [
      {
        attributeDefinitionId: store.definitionId,
        code: store.industry === 'BEAUTY' ? 'default' : 'm',
        id: store.defaultOptionId,
        labelEn: store.industry === 'BEAUTY' ? 'Default' : 'M',
        labelVi: store.industry === 'BEAUTY' ? 'Mặc định' : 'M',
        labelZh: store.industry === 'BEAUTY' ? '默认' : 'M',
        storeId: store.id,
      },
      {
        attributeDefinitionId: store.definitionId,
        code: store.optionCode,
        id: store.extraOptionId,
        labelEn: store.extraOptionLabels.en,
        labelVi: store.extraOptionLabels.vi,
        labelZh: store.extraOptionLabels.zh,
        sortOrder: 1,
        storeId: store.id,
      },
    ],
  });
  await database.attributeTemplateVersion.update({
    data: { activatedAt: new Date(), activatedBy: ACTOR_ID, status: 'ACTIVE' },
    where: { id: store.templateVersionId },
  });
  await database.attributeTemplate.update({
    data: { currentVersion: 1, status: 'ACTIVE', updatedBy: ACTOR_ID },
    where: { id: store.templateId },
  });
  await database.brand.create({
    data: {
      code: store.industry === 'BEAUTY' ? 'lumiere-lab' : 'forme-studio',
      id: store.brandId,
      recommended: true,
      storeId: store.id,
    },
  });
  await database.brandLocalization.createMany({
    data: (['vi', 'zh', 'en'] as const).map((locale) => ({
      brandId: store.brandId,
      introduction: store.translations.brandIntro[locale],
      locale,
      name: store.translations.brand[locale],
      storeId: store.id,
    })),
  });
  await database.brandMedia.create({
    data: {
      brandId: store.brandId,
      mediaId: store.mediaIds[2],
      purpose: 'LOGO',
      storeId: store.id,
    },
  });
  await database.categoryMedia.create({
    data: {
      categoryId: store.categoryId,
      mediaId: store.mediaIds[1],
      purpose: 'COVER',
      storeId: store.id,
    },
  });

  for (const [index, productId] of store.productIds.entries()) {
    await database.product.create({
      data: {
        attributeTemplateVersionId: store.templateVersionId,
        brandId: store.brandId,
        code:
          store.industry === 'BEAUTY'
            ? index === 0
              ? 'dew-renewal-serum'
              : 'velvet-petal-tint'
            : index === 0
              ? 'air-linen-shirt'
              : 'column-day-dress',
        id: productId,
        mainCategoryId: store.categoryId,
        publishedAt: new Date(Date.now() - index * 86_400_000),
        status: 'PUBLISHED',
        storeId: store.id,
      },
    });
    await database.productLocalization.createMany({
      data: (['vi', 'zh', 'en'] as const).map((locale: FixtureLocale) => ({
        descriptionDocument: {
          type: 'doc',
          value: `${store.translations.productNames[index][locale]}. ${store.translations.productPoints[index][locale]}.`,
        },
        locale,
        name: store.translations.productNames[index][locale],
        productId,
        sellingPoints: store.translations.productPoints[index][locale],
        storeId: store.id,
        subtitle: store.translations.brandIntro[locale],
        usageInstructions:
          store.industry === 'BEAUTY'
            ? locale === 'vi'
              ? 'Dùng lượng vừa đủ trên da sạch.'
              : locale === 'zh'
                ? '洁面后取适量使用。'
                : 'Apply a small amount to clean skin.'
            : locale === 'vi'
              ? 'Giặt nhẹ và phơi trong bóng râm.'
              : locale === 'zh'
                ? '轻柔洗涤并阴干。'
                : 'Wash gently and dry in the shade.',
      })),
    });
    await database.productVersion.create({
      data: {
        contentHash: createHash('sha256').update(`${store.id}:${productId}:v1`).digest('hex'),
        createdBy: ACTOR_ID,
        productId,
        publicationStatus: 'PUBLISHED',
        publishedAt: new Date(Date.now() - index * 86_400_000),
        publishedBy: ACTOR_ID,
        snapshot: { fixture: 'm3.4-browser-search' },
        storeId: store.id,
        version: 1,
      },
    });
    await database.productMedia.create({
      data: {
        mediaId: store.mediaIds[index + 3],
        productId,
        purpose: 'PRIMARY',
        storeId: store.id,
      },
    });
  }

  const skuInputs = [
    {
      code: `${store.storeCode}-primary-default`,
      id: store.skuIds[0],
      optionId: store.defaultOptionId,
      productId: store.productIds[0],
      salePriceVnd: store.industry === 'BEAUTY' ? 349_000 : 659_000,
    },
    {
      code: `${store.storeCode}-primary-extra`,
      id: store.skuIds[1],
      optionId: store.extraOptionId,
      productId: store.productIds[0],
      salePriceVnd: store.industry === 'BEAUTY' ? 379_000 : 679_000,
    },
    {
      code: `${store.storeCode}-secondary-default`,
      id: store.skuIds[2],
      optionId: store.defaultOptionId,
      productId: store.productIds[1],
      salePriceVnd: store.industry === 'BEAUTY' ? 229_000 : 799_000,
    },
  ];
  for (const input of skuInputs) {
    const optionCode =
      input.optionId === store.extraOptionId
        ? store.optionCode
        : store.industry === 'BEAUTY'
          ? 'default'
          : 'm';
    const combinationKey = `${store.industry === 'BEAUTY' ? 'shade' : 'size'}=${optionCode}`;
    await database.sku.create({
      data: {
        code: input.code,
        id: input.id,
        marketPriceVnd: input.salePriceVnd + 70_000,
        optionCombinationHash: createHash('sha256').update(combinationKey).digest('hex'),
        optionCombinationKey: combinationKey,
        productId: input.productId,
        salePriceVnd: input.salePriceVnd,
        storeId: store.id,
      },
    });
    await database.skuOptionValue.create({
      data: {
        attributeDefinitionId: store.definitionId,
        optionId: input.optionId,
        skuId: input.id,
        storeId: store.id,
      },
    });
    const warehouse = await database.warehouse.findUniqueOrThrow({
      where: { storeId_code: { code: 'local-default', storeId: store.id } },
    });
    await database.inventoryBalance.create({
      data: { skuId: input.id, storeId: store.id, warehouseId: warehouse.id },
    });
  }

  const warehouse = await database.warehouse.findUniqueOrThrow({
    where: { storeId_code: { code: 'local-default', storeId: store.id } },
  });
  const inventoryContext = createStoreContext({
    accessReason: 'M3.4 browser fixture initial stock',
    actor: { id: ACTOR_ID, type: 'member' },
    correlationId: `m34-browser-${store.storeCode}`,
    locale: 'vi',
    storeCode: store.storeCode,
    storeId: store.id,
  });
  await adjustInventory(database, inventoryContext, {
    audit: { action: 'test.inventory.initialized', targetType: 'inventory_operation' },
    items: [
      {
        delta: 12,
        expectedVersion: 1,
        reasonCode: 'BROWSER_FIXTURE_INITIAL_LOAD',
        skuId: store.skuIds[0],
        warehouseId: warehouse.id,
      },
      {
        delta: 8,
        expectedVersion: 1,
        reasonCode: 'BROWSER_FIXTURE_INITIAL_LOAD',
        skuId: store.skuIds[1],
        warehouseId: warehouse.id,
      },
    ],
    operationKey: `m34-browser-stock-${store.storeCode}`,
    operationType: 'IMPORT',
  });
  await withStoreTransaction(database, inventoryContext, (transaction) =>
    rebuildStoreSearchProjection(transaction, store.id),
  );

  await database.page.create({
    data: {
      code: 'home',
      createdBy: ACTOR_ID,
      id: store.pageId,
      status: 'DRAFT',
      storeId: store.id,
      updatedBy: ACTOR_ID,
    },
  });
  await database.pageVersion.create({
    data: {
      createdBy: ACTOR_ID,
      id: store.pageVersionId,
      pageId: store.pageId,
      publicationStatus: 'PUBLISHED',
      publishedAt: new Date(),
      publishedBy: ACTOR_ID,
      storeId: store.id,
      version: 1,
    },
  });
  const types = ['HERO', 'CATEGORY_GRID', 'BRAND_GRID', 'PRODUCT_GRID'] as const;
  for (const [index, id] of store.pageModuleIds.entries()) {
    await database.pageModule.create({
      data: {
        backgroundConfig: { color: store.colors[0], overlay: 0.08 },
        id,
        moduleType: types[index]!,
        pageVersionId: store.pageVersionId,
        sortOrder: index,
        storeId: store.id,
        targetId: index === 0 ? store.productIds[0] : null,
        targetType: index === 0 ? 'PRODUCT' : null,
      },
    });
    await database.pageModuleLocalization.createMany({
      data: (['vi', 'zh', 'en'] as const).map((locale) => ({
        buttonLabel:
          index === 0
            ? locale === 'vi'
              ? 'Khám phá'
              : locale === 'zh'
                ? '立即探索'
                : 'Explore'
            : null,
        contentConfig:
          index === 1
            ? { item_ids: [store.categoryId], layout: 'GRID' }
            : index === 2
              ? { item_ids: [store.brandId], layout: 'GRID' }
              : index === 3
                ? { item_ids: store.productIds, layout: 'GRID' }
                : { eyebrow: store.industry === 'BEAUTY' ? 'Beauty ritual' : 'New form' },
        locale,
        pageModuleId: id,
        storeId: store.id,
        summary: index === 0 ? store.translations.heroSummary[locale] : null,
        title:
          index === 0
            ? store.translations.hero[locale]
            : index === 1
              ? locale === 'vi'
                ? 'Khám phá danh mục'
                : locale === 'zh'
                  ? '探索分类'
                  : 'Explore categories'
              : index === 2
                ? locale === 'vi'
                  ? 'Thương hiệu nổi bật'
                  : locale === 'zh'
                    ? '精选品牌'
                    : 'Featured brand'
                : locale === 'vi'
                  ? 'Chọn riêng cho bạn'
                  : locale === 'zh'
                    ? '为你精选'
                    : 'Selected for you',
      })),
    });
  }
  await database.pageModuleMedia.create({
    data: {
      mediaId: store.mediaIds[0],
      pageModuleId: store.pageModuleIds[0],
      purpose: 'COVER',
      storeId: store.id,
    },
  });
  await database.page.update({
    data: { currentPublishedVersionId: store.pageVersionId, status: 'PUBLISHED' },
    where: { id: store.pageId },
  });
}

async function removeFixtures(): Promise<void> {
  const media = await database.mediaAsset.findMany({
    select: { objectKey: true },
    where: { id: { in: stores.flatMap(({ mediaIds }) => [...mediaIds]) } },
  });
  await Promise.all(
    media.map(({ objectKey }) => storage.removeObject(objectKey).catch(() => undefined)),
  );
  await database.$transaction(async (transaction) => {
    await transaction.$executeRaw`SET LOCAL session_replication_role = replica`;
    const pageModuleIds = stores.flatMap(({ pageModuleIds }) => [...pageModuleIds]);
    const productIds = stores.flatMap(({ productIds }) => [...productIds]);
    const skuIds = stores.flatMap(({ skuIds }) => [...skuIds]);
    const storeIds = stores.map(({ id }) => id);
    const browserIdentities = await transaction.memberExternalIdentity.findMany({
      select: { memberId: true },
      where: {
        provider: 'ZALO',
        providerSubjectId: { startsWith: 'm37-browser-' },
        storeId: { in: storeIds },
      },
    });
    const browserMemberIds = [...new Set(browserIdentities.map(({ memberId }) => memberId))];
    if (browserMemberIds.length > 0) {
      const browserCarts = await transaction.cart.findMany({
        select: { id: true },
        where: { memberId: { in: browserMemberIds }, storeId: { in: storeIds } },
      });
      const browserCartIds = browserCarts.map(({ id }) => id);
      await transaction.memberCoupon.deleteMany({
        where: { memberId: { in: browserMemberIds }, storeId: { in: storeIds } },
      });
      await transaction.memberSearchHistory.deleteMany({
        where: { memberId: { in: browserMemberIds }, storeId: { in: storeIds } },
      });
      if (browserCartIds.length > 0) {
        await transaction.cartItem.deleteMany({
          where: { cartId: { in: browserCartIds }, storeId: { in: storeIds } },
        });
        await transaction.cart.deleteMany({
          where: { id: { in: browserCartIds }, storeId: { in: storeIds } },
        });
      }
      await transaction.memberPhoneContact.deleteMany({
        where: { memberId: { in: browserMemberIds }, storeId: { in: storeIds } },
      });
      await transaction.consent.deleteMany({
        where: { memberId: { in: browserMemberIds }, storeId: { in: storeIds } },
      });
      await transaction.memberSession.deleteMany({
        where: { memberId: { in: browserMemberIds }, storeId: { in: storeIds } },
      });
      await transaction.memberExternalIdentity.deleteMany({
        where: { memberId: { in: browserMemberIds }, storeId: { in: storeIds } },
      });
      await transaction.member.deleteMany({
        where: { id: { in: browserMemberIds }, storeId: { in: storeIds } },
      });
    }
    const browserPromotions = await transaction.promotion.findMany({
      select: { id: true, versions: { select: { id: true } } },
      where: {
        OR: [{ code: { startsWith: 'm35-browser-' } }, { code: { startsWith: 'm37-browser-' } }],
        storeId: { in: storeIds },
      },
    });
    const promotionIds = browserPromotions.map(({ id }) => id);
    const promotionVersionIds = browserPromotions.flatMap(({ versions }) =>
      versions.map(({ id }) => id),
    );
    const browserCoupons = await transaction.coupon.findMany({
      select: { id: true },
      where: { promotionVersionId: { in: promotionVersionIds }, storeId: { in: storeIds } },
    });
    const couponIds = browserCoupons.map(({ id }) => id);
    await transaction.promotionOperation.deleteMany({
      where: {
        OR: [
          { targetId: { in: promotionIds }, targetType: 'promotion' },
          { targetId: { in: couponIds }, targetType: 'coupon' },
        ],
        storeId: { in: storeIds },
      },
    });
    await transaction.memberCoupon.deleteMany({ where: { couponId: { in: couponIds } } });
    await transaction.coupon.deleteMany({ where: { id: { in: couponIds } } });
    await transaction.promotionTarget.deleteMany({
      where: { promotionVersionId: { in: promotionVersionIds } },
    });
    await transaction.promotionVersionLocalization.deleteMany({
      where: { promotionVersionId: { in: promotionVersionIds } },
    });
    await transaction.promotionVersion.deleteMany({ where: { id: { in: promotionVersionIds } } });
    await transaction.promotion.deleteMany({ where: { id: { in: promotionIds } } });
    await transaction.pageModuleMedia.deleteMany({
      where: { pageModuleId: { in: pageModuleIds } },
    });
    await transaction.pageModuleLocalization.deleteMany({
      where: { pageModuleId: { in: pageModuleIds } },
    });
    await transaction.pageModule.deleteMany({ where: { id: { in: pageModuleIds } } });
    await transaction.pageVersion.deleteMany({
      where: { id: { in: stores.map(({ pageVersionId }) => pageVersionId) } },
    });
    await transaction.page.deleteMany({
      where: { id: { in: stores.map(({ pageId }) => pageId) } },
    });
    await transaction.productSearchDocument.deleteMany({
      where: { productId: { in: productIds } },
    });
    const fixtureOperationRows = await transaction.inventoryMovement.findMany({
      select: { operationId: true },
      where: { balance: { skuId: { in: skuIds } } },
    });
    const fixtureOperationIds = [
      ...new Set(fixtureOperationRows.map(({ operationId }) => operationId)),
    ];
    await transaction.inventoryMovement.deleteMany({
      where: { balance: { skuId: { in: skuIds } } },
    });
    await transaction.inventoryOperation.deleteMany({
      where: {
        OR: [
          { id: { in: fixtureOperationIds } },
          { operationKey: { startsWith: 'm34-browser-stock-' } },
          { operationKey: { startsWith: 'm37-browser-stock-' } },
        ],
      },
    });
    await transaction.inventoryBalance.deleteMany({ where: { skuId: { in: skuIds } } });
    await transaction.skuOptionValue.deleteMany({ where: { skuId: { in: skuIds } } });
    await transaction.sku.deleteMany({ where: { id: { in: skuIds } } });
    await transaction.productMedia.deleteMany({ where: { productId: { in: productIds } } });
    await transaction.productLocalization.deleteMany({ where: { productId: { in: productIds } } });
    await transaction.productVersion.deleteMany({ where: { productId: { in: productIds } } });
    await transaction.product.deleteMany({ where: { id: { in: productIds } } });
    await transaction.brandMedia.deleteMany({
      where: { brandId: { in: stores.map(({ brandId }) => brandId) } },
    });
    await transaction.categoryMedia.deleteMany({
      where: { mediaId: { in: stores.flatMap(({ mediaIds }) => [...mediaIds]) } },
    });
    await transaction.brandLocalization.deleteMany({
      where: { brandId: { in: stores.map(({ brandId }) => brandId) } },
    });
    await transaction.brand.deleteMany({
      where: { id: { in: stores.map(({ brandId }) => brandId) } },
    });
    await transaction.mediaAsset.deleteMany({
      where: { id: { in: stores.flatMap(({ mediaIds }) => [...mediaIds]) } },
    });
    await transaction.attributeOption.deleteMany({
      where: {
        id: {
          in: stores.flatMap(({ defaultOptionId, extraOptionId }) => [
            defaultOptionId,
            extraOptionId,
          ]),
        },
      },
    });
    await transaction.attributeDefinition.deleteMany({
      where: { id: { in: stores.map(({ definitionId }) => definitionId) } },
    });
    await transaction.attributeTemplateVersion.deleteMany({
      where: { id: { in: stores.map(({ templateVersionId }) => templateVersionId) } },
    });
    await transaction.attributeTemplate.deleteMany({
      where: { id: { in: stores.map(({ templateId }) => templateId) } },
    });
    // Audit logs are append-only by design. Keep the fixture's initialization
    // history instead of attempting a forbidden DELETE during the next run.
  });
}

function browserStore(storeCode: string): StoreFixture {
  const store = stores.find((candidate) => candidate.storeCode === storeCode);
  if (!store) throw new Error(`Unknown browser fixture store: ${storeCode}`);
  return store;
}

export async function setM37BrowserPrimarySkuPrice(
  storeCode: string,
  salePriceVnd: number,
): Promise<number> {
  if (!Number.isSafeInteger(salePriceVnd) || salePriceVnd < 0) {
    throw new Error('Browser fixture price must be a non-negative safe integer');
  }
  const store = browserStore(storeCode);
  await database.$connect();
  try {
    const current = await database.sku.findUniqueOrThrow({
      select: { salePriceVnd: true },
      where: { id: store.skuIds[0] },
    });
    await database.sku.update({
      data: { salePriceVnd },
      where: { id: store.skuIds[0] },
    });
    return Number(current.salePriceVnd);
  } finally {
    await database.$disconnect();
  }
}

export async function setM37BrowserPrimarySkuStock(
  storeCode: string,
  onHand: number,
): Promise<number> {
  if (!Number.isSafeInteger(onHand) || onHand < 0) {
    throw new Error('Browser fixture stock must be a non-negative safe integer');
  }
  const store = browserStore(storeCode);
  await database.$connect();
  try {
    const warehouse = await database.warehouse.findUniqueOrThrow({
      where: { storeId_code: { code: 'local-default', storeId: store.id } },
    });
    const balance = await database.inventoryBalance.findUniqueOrThrow({
      where: {
        storeId_warehouseId_skuId: {
          skuId: store.skuIds[0],
          storeId: store.id,
          warehouseId: warehouse.id,
        },
      },
    });
    if (balance.reserved !== 0) throw new Error('Browser fixture stock is unexpectedly reserved');
    if (balance.onHand === onHand) return balance.onHand;
    await adjustInventory(
      database,
      createStoreContext({
        accessReason: 'M3.7 browser cart state transition',
        actor: { id: ACTOR_ID, type: 'member' },
        correlationId: `m37-browser-${randomUUID()}`,
        locale: 'vi',
        storeCode: store.storeCode,
        storeId: store.id,
      }),
      {
        items: [
          {
            delta: onHand - balance.onHand,
            expectedVersion: balance.version,
            reasonCode: 'M37_BROWSER_CART_STATE',
            skuId: store.skuIds[0],
            warehouseId: warehouse.id,
          },
        ],
        operationKey: `m37-browser-stock-${randomUUID()}`,
      },
    );
    return balance.onHand;
  } finally {
    await database.$disconnect();
  }
}

export async function setUpM26BrowserFixtures(): Promise<void> {
  await database.$connect();
  try {
    await removeFixtures();
    for (const store of stores) await seedStore(store);
  } finally {
    await database.$disconnect();
  }
}

export async function tearDownM26BrowserFixtures(): Promise<void> {
  await database.$connect();
  try {
    await removeFixtures();
  } finally {
    await database.$disconnect();
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === 'up') await setUpM26BrowserFixtures();
  else if (process.argv[2] === 'down') await tearDownM26BrowserFixtures();
  else throw new Error('Usage: m26-browser-fixture.ts <up|down>');
}

const entryPoint = process.argv[1]?.replaceAll('\\', '/');
if (entryPoint?.endsWith('/m26-browser-fixture.ts')) void main();
