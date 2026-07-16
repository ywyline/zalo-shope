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
}

void seed();
