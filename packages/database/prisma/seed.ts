import {
  DeploymentEnvironment,
  Locale,
  PermissionScope,
  PrismaClient,
  StoreIndustry,
} from '@prisma/client';

const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';

const permissionSeeds = [
  ['platform.stores.read', PermissionScope.PLATFORM, 'Read platform store registry'],
  ['platform.stores.manage', PermissionScope.PLATFORM, 'Manage platform store registry'],
  ['platform.stores.cross_access', PermissionScope.PLATFORM, 'Access stores through audited path'],
  ['platform.rbac.manage', PermissionScope.PLATFORM, 'Manage platform roles'],
  ['platform.audit.read', PermissionScope.PLATFORM, 'Read platform audit events'],
  ['store.config.read', PermissionScope.STORE, 'Read current store configuration'],
  ['store.config.manage', PermissionScope.STORE, 'Manage current store configuration'],
  ['store.members.read', PermissionScope.STORE, 'Read current store members'],
  ['store.rbac.read', PermissionScope.STORE, 'Read current store roles'],
  ['store.rbac.manage', PermissionScope.STORE, 'Manage current store roles'],
  ['store.audit.read', PermissionScope.STORE, 'Read current store audit events'],
  ['store.catalog.read', PermissionScope.STORE, 'Read current store catalog'],
  ['store.catalog.manage', PermissionScope.STORE, 'Manage current store catalog drafts'],
  ['store.catalog.publish', PermissionScope.STORE, 'Review and publish current store catalog'],
  ['store.compliance.read', PermissionScope.STORE, 'Read current store compliance metadata'],
  ['store.compliance.review', PermissionScope.STORE, 'Review current store compliance records'],
  ['store.content.read', PermissionScope.STORE, 'Read current store page content'],
  ['store.content.manage', PermissionScope.STORE, 'Manage current store page content'],
] as const;

async function seed(): Promise<void> {
  if (!['development', 'test'].includes(process.env.NODE_ENV ?? '')) {
    throw new Error('M1 seed is restricted to development and test environments');
  }

  const client = new PrismaClient();
  try {
    for (const [code, scope, description] of permissionSeeds) {
      await client.permission.upsert({
        create: { code, description, scope },
        update: { description, scope },
        where: { code },
      });
    }

    await seedStore(client, {
      code: 'beauty-local',
      colors: { accent: '#c96f72', background: '#fffaf7', text: '#2c2020' },
      id: BEAUTY_STORE_ID,
      industry: StoreIndustry.BEAUTY,
      names: {
        [Locale.en]: 'Beauty Store',
        [Locale.vi]: 'Cửa hàng Mỹ phẩm',
        [Locale.zh]: '美妆商城',
      },
      roleName: 'Quản trị cửa hàng mỹ phẩm',
    });

    await seedStore(client, {
      code: 'fashion-local',
      colors: { accent: '#8b7564', background: '#fbfaf8', text: '#22201e' },
      id: FASHION_STORE_ID,
      industry: StoreIndustry.FASHION,
      names: {
        [Locale.en]: 'Fashion Store',
        [Locale.vi]: 'Cửa hàng Thời trang',
        [Locale.zh]: '服装商城',
      },
      roleName: 'Quản trị cửa hàng thời trang',
    });
  } finally {
    await client.$disconnect();
  }
}

async function seedStore(
  client: PrismaClient,
  input: {
    code: string;
    colors: Record<string, string>;
    id: string;
    industry: StoreIndustry;
    names: Record<Locale, string>;
    roleName: string;
  },
): Promise<void> {
  await client.store.upsert({
    create: { code: input.code, id: input.id, industry: input.industry },
    update: { industry: input.industry },
    where: { code: input.code },
  });

  for (const locale of Object.values(Locale)) {
    await client.storeLocalization.upsert({
      create: { displayName: input.names[locale], locale, storeId: input.id },
      update: { displayName: input.names[locale] },
      where: { storeId_locale: { locale, storeId: input.id } },
    });
  }

  await client.storeTheme.upsert({
    create: {
      colorTokens: input.colors,
      radiusTokens: { card: 16, control: 12 },
      storeId: input.id,
      typographyTokens: { body: 'Inter, system-ui, sans-serif' },
    },
    update: {
      colorTokens: input.colors,
      radiusTokens: { card: 16, control: 12 },
      typographyTokens: { body: 'Inter, system-ui, sans-serif' },
    },
    where: { storeId: input.id },
  });

  await client.storeZaloApp.upsert({
    create: { environment: DeploymentEnvironment.TEST, storeId: input.id },
    update: { enabled: false, miniAppId: null, oaId: null, parentAppId: null },
    where: { storeId_environment: { environment: DeploymentEnvironment.TEST, storeId: input.id } },
  });

  const role = await client.storeRole.upsert({
    create: {
      code: 'store-admin',
      isSystem: true,
      name: input.roleName,
      storeId: input.id,
    },
    update: { isSystem: true, name: input.roleName },
    where: { storeId_code: { code: 'store-admin', storeId: input.id } },
  });

  for (const [permissionCode, scope] of permissionSeeds) {
    if (scope !== PermissionScope.STORE) continue;
    await client.storeRolePermission.upsert({
      create: { permissionCode, roleId: role.id, storeId: input.id },
      update: {},
      where: {
        storeId_roleId_permissionCode: { permissionCode, roleId: role.id, storeId: input.id },
      },
    });
  }

  await seedCatalogFoundation(client, input);
}

async function seedCatalogFoundation(
  client: PrismaClient,
  input: { id: string; industry: StoreIndustry },
): Promise<void> {
  const isBeauty = input.industry === StoreIndustry.BEAUTY;
  const rootId = isBeauty
    ? '11000000-0000-4000-8000-000000000001'
    : '11000000-0000-4000-8000-000000000002';
  const childId = isBeauty
    ? '12000000-0000-4000-8000-000000000001'
    : '12000000-0000-4000-8000-000000000002';
  const templateId = isBeauty
    ? '13000000-0000-4000-8000-000000000001'
    : '13000000-0000-4000-8000-000000000002';
  const templateVersionId = isBeauty
    ? '14000000-0000-4000-8000-000000000001'
    : '14000000-0000-4000-8000-000000000002';
  const definitionId = isBeauty
    ? '15000000-0000-4000-8000-000000000001'
    : '15000000-0000-4000-8000-000000000002';
  const optionId = isBeauty
    ? '16000000-0000-4000-8000-000000000001'
    : '16000000-0000-4000-8000-000000000002';

  await client.category.upsert({
    create: {
      code: isBeauty ? 'beauty' : 'fashion',
      depth: 1,
      id: rootId,
      storeId: input.id,
    },
    update: { status: 'ACTIVE' },
    where: { storeId_code: { code: isBeauty ? 'beauty' : 'fashion', storeId: input.id } },
  });
  await client.category.upsert({
    create: {
      code: isBeauty ? 'beauty-general' : 'fashion-general',
      depth: 2,
      id: childId,
      parentId: rootId,
      storeId: input.id,
    },
    update: { parentId: rootId, status: 'ACTIVE' },
    where: {
      storeId_code: {
        code: isBeauty ? 'beauty-general' : 'fashion-general',
        storeId: input.id,
      },
    },
  });

  const categoryNames = isBeauty
    ? {
        en: ['Beauty', 'General beauty'],
        vi: ['Làm đẹp', 'Làm đẹp tổng hợp'],
        zh: ['美妆', '综合美妆'],
      }
    : {
        en: ['Fashion', 'General fashion'],
        vi: ['Thời trang', 'Thời trang tổng hợp'],
        zh: ['服装', '综合服装'],
      };
  for (const locale of Object.values(Locale)) {
    for (const [categoryId, name] of [
      [rootId, categoryNames[locale][0]!],
      [childId, categoryNames[locale][1]!],
    ] as const) {
      await client.categoryLocalization.upsert({
        create: { categoryId, locale, name, storeId: input.id },
        update: { name },
        where: { storeId_categoryId_locale: { categoryId, locale, storeId: input.id } },
      });
    }
  }

  await client.attributeTemplate.upsert({
    create: {
      code: isBeauty ? 'beauty-base' : 'fashion-base',
      currentVersion: 1,
      id: templateId,
      industry: input.industry,
      status: 'ACTIVE',
      storeId: input.id,
    },
    update: { currentVersion: 1, status: 'ACTIVE' },
    where: {
      storeId_code: { code: isBeauty ? 'beauty-base' : 'fashion-base', storeId: input.id },
    },
  });
  await client.attributeTemplateVersion.upsert({
    create: {
      activatedAt: new Date('2026-07-17T00:00:00.000Z'),
      id: templateVersionId,
      name: isBeauty ? 'Beauty base v1' : 'Fashion base v1',
      status: 'ACTIVE',
      storeId: input.id,
      templateId,
      version: 1,
    },
    update: {},
    where: {
      storeId_templateId_version: { storeId: input.id, templateId, version: 1 },
    },
  });
  await client.attributeDefinition.upsert({
    create: {
      code: isBeauty ? 'shade' : 'size',
      dataType: 'OPTION',
      id: definitionId,
      labelEn: isBeauty ? 'Shade' : 'Size',
      labelVi: isBeauty ? 'Tông màu' : 'Kích cỡ',
      labelZh: isBeauty ? '色号' : '尺码',
      purpose: 'SPECIFICATION',
      required: true,
      storeId: input.id,
      templateVersionId,
    },
    update: {},
    where: {
      storeId_templateVersionId_code: {
        code: isBeauty ? 'shade' : 'size',
        storeId: input.id,
        templateVersionId,
      },
    },
  });
  await client.attributeOption.upsert({
    create: {
      attributeDefinitionId: definitionId,
      code: isBeauty ? 'default' : 'm',
      id: optionId,
      labelEn: isBeauty ? 'Default' : 'M',
      labelVi: isBeauty ? 'Mặc định' : 'M',
      labelZh: isBeauty ? '默认' : 'M',
      storeId: input.id,
    },
    update: {},
    where: {
      storeId_attributeDefinitionId_code: {
        attributeDefinitionId: definitionId,
        code: isBeauty ? 'default' : 'm',
        storeId: input.id,
      },
    },
  });
  await client.categoryAttributeTemplate.upsert({
    create: {
      categoryId: childId,
      isPrimary: true,
      storeId: input.id,
      templateVersionId,
    },
    update: { isPrimary: true },
    where: {
      storeId_categoryId_templateVersionId: {
        categoryId: childId,
        storeId: input.id,
        templateVersionId,
      },
    },
  });
}

void seed();
