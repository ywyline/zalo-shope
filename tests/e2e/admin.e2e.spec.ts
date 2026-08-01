import { randomUUID } from 'node:crypto';

import { expect, test, type Page, type Response } from '@playwright/test';
import writeXlsxFile, { type SheetData } from 'write-excel-file/node';

import { generateTotp } from '@zalo-shop/security';

import { PRODUCT_IMPORT_COLUMNS } from '../../apps/api/src/catalog-admin/product-import';

const ADMIN_URL = 'http://127.0.0.1:5173/';
const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type E2eCredentials = { email: string; password: string; totpSecret: string };
type E2eCredentialKind = 'full' | 'readonly';

function credentials(kind: E2eCredentialKind = 'full'): E2eCredentials {
  const variable = kind === 'readonly' ? 'ZALO_SHOP_E2E_READONLY_ADMIN' : 'ZALO_SHOP_E2E_ADMIN';
  const serialized = process.env[variable];
  if (!serialized) throw new Error(`${variable} was not prepared by global setup`);
  return JSON.parse(serialized) as E2eCredentials;
}

async function signIn(page: Page, kind: E2eCredentialKind = 'full'): Promise<void> {
  const account = credentials(kind);
  await page.goto(ADMIN_URL);
  await page.getByLabel('Language').selectOption('en');
  await page.getByLabel('Admin email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Verify MFA' })).toBeVisible();
  await page.getByLabel('6-digit code').fill(generateTotp(account.totpSecret));
  await page.getByRole('button', { name: 'Verify MFA' }).click();
  await expect(page.getByRole('heading', { name: 'Operations center' })).toBeVisible();
}

function inventoryRow(page: Page, skuCode: string) {
  return page.locator('.inventory-table tbody tr').filter({ hasText: skuCode });
}

async function inventoryOnHand(page: Page, skuCode: string): Promise<number> {
  const value = (await inventoryRow(page, skuCode).locator('td').nth(1).textContent())?.trim();
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`Could not read on-hand inventory for ${skuCode}`);
  }
  return Number(value);
}

async function prepareInventoryAdjustment(
  page: Page,
  skuCode: string,
  delta: number,
  note: string,
) {
  const row = inventoryRow(page, skuCode);
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Adjust stock' }).click();
  const form = page.locator('form.inventory-dialog');
  await expect(form).toContainText(skuCode);
  await form.getByLabel('Quantity delta').fill(String(delta));
  await form.getByLabel('Reason').selectOption('CYCLE_COUNT');
  await form.getByLabel('Note without sensitive data').fill(note);
  await form.getByLabel('ADJUST', { exact: true }).fill('ADJUST');
  return form;
}

async function submitInventoryAdjustment(
  page: Page,
  skuCode: string,
  delta: number,
  note: string,
): Promise<Response> {
  const form = await prepareInventoryAdjustment(page, skuCode, delta, note);
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes('/v1/admin/inventory/adjustments'),
  );
  await form.getByRole('button', { name: 'Adjust stock' }).click();
  return responsePromise;
}

async function createPromotionDraft(page: Page, promotionCode: string): Promise<void> {
  await page.getByRole('button', { name: 'Promotions & pricing' }).click();
  await expect(page.getByRole('heading', { name: 'Promotions & pricing' })).toBeVisible();
  await page.getByRole('button', { name: 'New promotion' }).click();
  const form = page.locator('form.promotion-dialog');
  await form.getByLabel('Code').fill(promotionCode);
  await form.getByLabel('Pricing bucket').selectOption('ITEM');
  await form.getByLabel('Benefit method').selectOption('FIXED_VND');
  await form.getByLabel('Benefit value').fill('1000');
  await form
    .getByLabel('Starts at')
    .fill(new Date(Date.now() - 86_400_000).toISOString().slice(0, 16));
  await form.getByLabel('Vietnamese name').fill(`Khuyen mai RBAC ${promotionCode.slice(-8)}`);
  await form.getByLabel('English name').fill(`RBAC promotion ${promotionCode.slice(-8)}`);

  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/v1\/admin\/promotions\/[^/]+\/versions/.test(response.url()),
  );
  await form.getByRole('button', { name: 'Save draft' }).click();
  expect((await responsePromise).ok()).toBe(true);
  await expect(
    page.locator('.promotion-table tbody tr').filter({ hasText: promotionCode }),
  ).toContainText('Draft');
}

async function importWorkbook(): Promise<Buffer> {
  const values: Record<(typeof PRODUCT_IMPORT_COLUMNS)[number], string | number | null> = {
    barcode: '893284000001',
    brand_code: 'lumiere-lab',
    cost_price_vnd: 190_000,
    description_en: 'Browser dry-run description',
    description_vi: 'Mô tả kiểm tra trình duyệt',
    description_zh: '浏览器校验说明',
    main_category_code: 'beauty-general',
    market_price_vnd: 320_000,
    name_en: 'Browser dry-run serum',
    name_vi: 'Tinh chất kiểm tra trình duyệt',
    name_zh: '浏览器校验精华',
    product_code: `m284-dry-${randomUUID().slice(0, 8)}`,
    sale_price_vnd: 280_000,
    secondary_category_codes: null,
    selling_points_en: 'Dry-run only',
    selling_points_vi: 'Chỉ kiểm tra',
    selling_points_zh: '仅校验',
    sku_code: `m284-sku-${randomUUID().slice(0, 8)}`,
    sku_options: 'shade=default',
    weight_grams: 120,
  };
  return writeXlsxFile(
    [
      [...PRODUCT_IMPORT_COLUMNS],
      PRODUCT_IMPORT_COLUMNS.map((column) => values[column]),
    ] as SheetData,
    { sheet: 'products' },
  ).toBuffer();
}

test('admin catalog stays isolated, localized and supports the XLSX dry-run flow', async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));

  await signIn(page);
  await page.getByRole('button', { name: /Catalog & compliance/ }).click();
  await expect(page.getByText('Dew Renewal Serum', { exact: true })).toBeVisible();
  await expect(page.getByText('Air Linen Shirt', { exact: true })).toHaveCount(0);

  const storeSelect = page.getByLabel('Select store');
  await storeSelect.selectOption(FASHION_STORE_ID);
  await expect(page.getByText('Air Linen Shirt', { exact: true })).toBeVisible();
  await expect(page.getByText('Dew Renewal Serum', { exact: true })).toHaveCount(0);

  const language = page.getByLabel('Language');
  await language.selectOption('zh');
  await expect(page.getByText('受限 XLSX 导入', { exact: true })).toBeVisible();
  await language.selectOption('vi');
  await expect(page.getByText('Nhập XLSX có kiểm soát', { exact: true })).toBeVisible();
  await language.selectOption('en');
  await expect(page.getByText('Restricted XLSX import', { exact: true })).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download XLSX template' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('product-import-template.xlsx');
  expect(await download.failure()).toBeNull();

  await storeSelect.selectOption(BEAUTY_STORE_ID);
  await expect(page.getByText('Dew Renewal Serum', { exact: true })).toBeVisible();
  await page.getByLabel('Select XLSX file').setInputFiles({
    buffer: await importWorkbook(),
    mimeType: XLSX_MIME,
    name: 'm284-browser-dry-run.xlsx',
  });
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes('/v1/admin/catalog/products/imports/xlsx'),
  );
  await page.getByRole('button', { name: 'Validate file' }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  await expect(page.locator('.xlsx-summary')).toContainText('1 validated');
  await expect(page.locator('.xlsx-rows')).toContainText('VALIDATED');

  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(browserErrors).toEqual([]);
});

test('inventory workbench stays isolated, supports reversible adjustments and validates an atomic initial-load file', async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));

  await signIn(page);
  await page.getByRole('button', { name: 'Warehouses & inventory' }).click();
  await expect(page.getByRole('heading', { name: 'Warehouses & inventory' })).toBeVisible();
  await expect(page.getByText('beauty-local-primary-default', { exact: true })).toBeVisible();
  await expect(page.getByText('fashion-local-primary-default', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Warehouses', exact: true }).click();
  await expect(page.getByText('Beauty local test warehouse', { exact: true })).toBeVisible();

  const storeSelect = page.getByLabel('Select store');
  await storeSelect.selectOption(FASHION_STORE_ID);
  await expect(page.getByText('fashion-local-primary-default', { exact: true })).toBeVisible();
  await expect(page.getByText('beauty-local-primary-default', { exact: true })).toHaveCount(0);

  await storeSelect.selectOption(BEAUTY_STORE_ID);

  const primarySku = 'beauty-local-primary-default';
  const startingOnHand = await inventoryOnHand(page, primarySku);
  let restoreAdjustment = false;
  try {
    const adjustment = await submitInventoryAdjustment(
      page,
      primarySku,
      1,
      'M3.7 browser reversible adjustment',
    );
    restoreAdjustment = adjustment.status() === 200;
    expect(adjustment.status()).toBe(200);
    await expect(inventoryRow(page, primarySku).locator('td').nth(1)).toHaveText(
      String(startingOnHand + 1),
    );
  } finally {
    if (restoreAdjustment) {
      const restore = await submitInventoryAdjustment(
        page,
        primarySku,
        -1,
        'M3.7 browser reversible adjustment restore',
      );
      expect(restore.status()).toBe(200);
      await expect(inventoryRow(page, primarySku).locator('td').nth(1)).toHaveText(
        String(startingOnHand),
      );
    }
  }

  await page.getByRole('button', { name: 'Initial stock import' }).click();
  await page.getByLabel('CSV / XLSX file').setInputFiles({
    buffer: Buffer.from(
      'warehouse_code,sku_code,quantity,note\nlocal-default,beauty-local-secondary-default,1,Browser validation only\n',
    ),
    mimeType: 'text/csv',
    name: 'inventory-browser-dry-run.csv',
  });
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes('/v1/admin/inventory/imports') &&
      response.url().includes('dry_run=true'),
  );
  await page.getByRole('button', { name: 'Validate file' }).click();
  expect((await responsePromise).ok()).toBe(true);
  await expect(page.locator('.inventory-import-report')).toContainText('VALID');

  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(browserErrors).toEqual([]);
});

test('fulfillment profile form is trilingual and submits only the audited warehouse contract', async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));

  let submitted: Record<string, unknown> | undefined;
  await page.route('**/v1/admin/inventory/warehouses/*/fulfillment-profile?*', async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.continue();
      return;
    }
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      contentType: 'application/json',
      json: {
        configured: true,
        district_code: 'quan-1',
        district_name: 'Quận 1',
        enabled: true,
        province_code: 'hcm',
        province_name: 'Thành phố Hồ Chí Minh',
        updated_at: new Date().toISOString(),
        version: 1,
        ward_code: 'ben-nghe',
        ward_name: 'Phường Bến Nghé',
      },
      status: 200,
    });
  });

  await signIn(page);
  await page.getByRole('button', { name: 'Warehouses & inventory' }).click();
  await page.getByRole('button', { name: 'Warehouses', exact: true }).click();
  const warehouse = page.locator('.warehouse-grid article').filter({
    hasText: 'Beauty local test warehouse',
  });
  await warehouse.getByRole('button', { name: 'Fulfillment profile' }).click();

  const language = page.getByLabel('Language');
  await language.selectOption('zh');
  await expect(page.getByRole('heading', { name: '仓库履约资料' })).toBeVisible();
  await language.selectOption('vi');
  await expect(page.getByRole('heading', { name: 'Thông tin lấy hàng' })).toBeVisible();
  await language.selectOption('en');

  const form = page.locator('form.fulfillment-profile-dialog');
  await expect(form.getByRole('heading', { name: 'Fulfillment profile' })).toBeVisible();
  const regions = form.locator('.fulfillment-region-fields select');
  await regions.nth(0).selectOption('hcm');
  await expect(regions.nth(1).locator('option[value="quan-1"]')).toHaveCount(1);
  await regions.nth(1).selectOption('quan-1');
  await expect(regions.nth(2).locator('option[value="ben-nghe"]')).toHaveCount(1);
  await regions.nth(2).selectOption('ben-nghe');
  await form.getByLabel('Detailed pickup address').fill('18 Browser Test Street');
  await form.getByLabel('Pickup contact').fill('Browser Fulfillment');
  await form.getByLabel('Pickup phone').fill('+84901234567');
  await form.getByLabel('Type FULFILLMENT to confirm').fill('FULFILLMENT');
  await form.getByRole('button', { name: 'Save fulfillment profile' }).click();

  await expect(page.locator('.inventory-workbench .workbench-message.success')).toContainText(
    'Inventory operation completed safely.',
  );
  expect(submitted).toMatchObject({
    confirmation_code: 'FULFILLMENT',
    contact_name: 'Browser Fulfillment',
    detail: '18 Browser Test Street',
    district_code: 'quan-1',
    enabled: true,
    expected_profile_version: 0,
    phone: '+84901234567',
    province_code: 'hcm',
    ward_code: 'ben-nghe',
  });
  expect(submitted).not.toHaveProperty('store_id');
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(browserErrors).toEqual([]);
});

test('independent admin sessions reject a stale inventory adjustment and restore the winning delta', async ({
  browser,
}) => {
  test.slow();
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const pageA = pages[0]!;
  const pageB = pages[1]!;
  const primarySku = 'beauty-local-primary-default';
  let startingOnHand: number | undefined;
  let restorePage: Page | undefined;
  let restoreDelta = 0;

  try {
    await Promise.all([signIn(pageA), signIn(pageB)]);
    await Promise.all(
      [pageA, pageB].map(async (page) => {
        await page.getByRole('button', { name: 'Warehouses & inventory' }).click();
        await expect(page.getByRole('heading', { name: 'Warehouses & inventory' })).toBeVisible();
        await expect(inventoryRow(page, primarySku)).toHaveCount(1);
      }),
    );

    startingOnHand = await inventoryOnHand(pageA, primarySku);
    expect(await inventoryOnHand(pageB, primarySku)).toBe(startingOnHand);

    const forms = await Promise.all(
      [pageA, pageB].map((page, index) =>
        prepareInventoryAdjustment(page, primarySku, 1, `M3.7 stale version session ${index + 1}`),
      ),
    );
    const responsePromises = [pageA, pageB].map((page) =>
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().includes('/v1/admin/inventory/adjustments'),
      ),
    );
    await Promise.all(
      forms.map((form) => form.getByRole('button', { name: 'Adjust stock' }).click()),
    );
    const responses = await Promise.all(responsePromises);
    const statuses = responses.map((response) => response.status());
    restoreDelta = statuses.filter((status) => status === 200).length;
    if (restoreDelta > 0) restorePage = [pageA, pageB][statuses.indexOf(200)];

    expect([...statuses].sort((left, right) => left - right)).toEqual([200, 409]);
    const conflictIndex = statuses.indexOf(409);
    if (conflictIndex >= 0) {
      const conflictMessage = [pageA, pageB][conflictIndex]!.locator(
        '.inventory-workbench .workbench-message.error',
      );
      await expect(conflictMessage).toContainText('Inventory data could not be loaded or saved.');
      await expect(conflictMessage.getByRole('button', { name: 'Retry' })).toBeVisible();
    }
    if (restorePage && startingOnHand !== undefined) {
      await expect(inventoryRow(restorePage, primarySku).locator('td').nth(1)).toHaveText(
        String(startingOnHand + restoreDelta),
      );
    }
  } finally {
    if (restorePage && startingOnHand !== undefined && restoreDelta > 0) {
      const restore = await submitInventoryAdjustment(
        restorePage,
        primarySku,
        -restoreDelta,
        'M3.7 browser stale version restore',
      );
      expect(restore.status()).toBe(200);
      await expect(inventoryRow(restorePage, primarySku).locator('td').nth(1)).toHaveText(
        String(startingOnHand),
      );
    }
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test('read-only admin receives recoverable 403 feedback for inventory and promotion writes', async ({
  browser,
}) => {
  test.slow();
  const fullContext = await browser.newContext();
  const readonlyContext = await browser.newContext();
  const fullPage = await fullContext.newPage();
  const readonlyPage = await readonlyContext.newPage();
  const promotionCode = `m37-browser-readonly-${randomUUID().slice(0, 8)}`;
  const primarySku = 'beauty-local-primary-default';

  try {
    await signIn(fullPage, 'full');
    await createPromotionDraft(fullPage, promotionCode);

    await signIn(readonlyPage, 'readonly');
    await readonlyPage.getByRole('button', { name: 'Warehouses & inventory' }).click();
    await expect(
      readonlyPage.getByRole('heading', { name: 'Warehouses & inventory' }),
    ).toBeVisible();
    const startingOnHand = await inventoryOnHand(readonlyPage, primarySku);
    const deniedInventory = await submitInventoryAdjustment(
      readonlyPage,
      primarySku,
      1,
      'M3.7 read-only inventory denial',
    );
    expect(deniedInventory.status()).toBe(403);
    const inventoryError = readonlyPage.locator('.inventory-workbench .workbench-message.error');
    await expect(inventoryError).toContainText('Inventory data could not be loaded or saved.');
    await expect(inventoryError.getByRole('button', { name: 'Retry' })).toBeVisible();
    await readonlyPage
      .locator('form.inventory-dialog')
      .getByRole('button', { name: 'Cancel' })
      .click();
    const inventoryReload = readonlyPage.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().includes('/v1/admin/inventory/balances'),
    );
    await inventoryError.getByRole('button', { name: 'Retry' }).click();
    expect((await inventoryReload).status()).toBe(200);
    await expect(inventoryRow(readonlyPage, primarySku).locator('td').nth(1)).toHaveText(
      String(startingOnHand),
    );

    await readonlyPage.getByRole('button', { name: 'Promotions & pricing' }).click();
    await expect(readonlyPage.getByRole('heading', { name: 'Promotions & pricing' })).toBeVisible();
    const beautyRow = readonlyPage
      .locator('.promotion-table tbody tr')
      .filter({ hasText: promotionCode });
    await expect(beautyRow).toContainText('Draft');

    const fashionPromotions = readonlyPage.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().includes('/v1/admin/promotions?') &&
        response.url().includes(FASHION_STORE_ID),
    );
    await readonlyPage.getByLabel('Select store').selectOption(FASHION_STORE_ID);
    expect((await fashionPromotions).status()).toBe(200);
    await expect(readonlyPage.locator('.promotion-workbench')).toBeVisible();
    await expect(
      readonlyPage.locator('.promotion-table tbody tr').filter({ hasText: promotionCode }),
    ).toHaveCount(0);

    const beautyPromotions = readonlyPage.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().includes('/v1/admin/promotions?') &&
        response.url().includes(BEAUTY_STORE_ID),
    );
    await readonlyPage.getByLabel('Select store').selectOption(BEAUTY_STORE_ID);
    expect((await beautyPromotions).status()).toBe(200);
    await expect(readonlyPage.locator('.promotion-workbench')).toBeVisible();
    await expect(
      readonlyPage.locator('.promotion-table tbody tr').filter({ hasText: promotionCode }),
    ).toContainText('Draft');

    await readonlyPage
      .locator('.promotion-table tbody tr')
      .filter({ hasText: promotionCode })
      .getByRole('button', { name: 'Publish' })
      .click();
    const confirmation = readonlyPage.getByRole('dialog');
    await expect(
      confirmation.getByRole('heading', { name: 'Confirm high-risk action' }),
    ).toBeVisible();
    await confirmation.getByLabel('PUBLISH').fill('PUBLISH');
    const deniedPublish = readonlyPage.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().includes('/publish'),
    );
    await confirmation.getByRole('button', { name: 'PUBLISH' }).click();
    expect((await deniedPublish).status()).toBe(403);
    const promotionError = readonlyPage.locator('.promotion-workbench .workbench-message.error');
    await expect(promotionError).toContainText('Promotion data could not be loaded or saved.');
    await expect(readonlyPage.getByRole('dialog')).toBeVisible();
    await readonlyPage.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    const promotionReload = readonlyPage.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        response.url().includes('/v1/admin/promotions?') &&
        response.url().includes(BEAUTY_STORE_ID),
    );
    await readonlyPage
      .locator('.promotion-workbench')
      .getByRole('button', { name: 'Reload' })
      .click();
    expect((await promotionReload).status()).toBe(200);
    await expect(
      readonlyPage.locator('.promotion-table tbody tr').filter({ hasText: promotionCode }),
    ).toContainText('Draft');
  } finally {
    await Promise.all([fullContext.close(), readonlyContext.close()]);
  }
});

test('promotion workbench creates and publishes a localized STORE rule with a live admin quote', async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));

  const promotionCode = `m35-browser-${randomUUID().slice(0, 8)}`;
  await signIn(page);
  await page.getByRole('button', { name: 'Promotions & pricing' }).click();
  await expect(page.getByRole('heading', { name: 'Promotions & pricing' })).toBeVisible();

  const language = page.getByLabel('Language');
  await language.selectOption('zh');
  await expect(page.getByRole('heading', { name: '促销与价格' })).toBeVisible();
  await language.selectOption('vi');
  await expect(page.getByRole('heading', { name: 'Khuyến mãi & định giá' })).toBeVisible();
  await language.selectOption('en');

  await page.getByRole('button', { name: 'New promotion' }).click();
  await page.getByLabel('Code').fill(promotionCode);
  await page.getByLabel('Pricing bucket').selectOption('ITEM');
  await page.getByLabel('Benefit method').selectOption('FIXED_VND');
  await page.getByLabel('Benefit value').fill('50000');
  await page
    .getByLabel('Starts at')
    .fill(new Date(Date.now() - 86_400_000).toISOString().slice(0, 16));
  await page.getByLabel('Vietnamese name').fill('Giảm 50K toàn cửa hàng');
  await page.getByLabel('Vietnamese description').fill('Ưu đãi kiểm tra trình duyệt');
  await page.getByLabel('Chinese name').fill('全场立减 50K');
  await page.getByLabel('Chinese description').fill('浏览器促销验收');
  await page.getByLabel('English name').fill('Storewide VND 50K off');
  await page.getByLabel('English description').fill('Browser promotion acceptance');

  const draftResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/v1\/admin\/promotions\/[^/]+\/versions/.test(response.url()),
  );
  await page.getByRole('button', { name: 'Save draft' }).click();
  expect((await draftResponse).ok()).toBe(true);

  const promotionRow = page.locator('.promotion-table tbody tr').filter({ hasText: promotionCode });
  await expect(promotionRow).toContainText('Draft');
  await promotionRow.getByRole('button', { name: 'Publish' }).click();

  const confirmation = page.getByRole('dialog');
  await expect(
    confirmation.getByRole('heading', { name: 'Confirm high-risk action' }),
  ).toBeVisible();
  await confirmation.getByLabel('PUBLISH').fill('PUBLISH');
  const publishResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes('/publish'),
  );
  await confirmation.getByRole('button', { name: 'PUBLISH' }).click();
  expect((await publishResponse).ok()).toBe(true);
  await expect(promotionRow).toContainText('Active');

  await language.selectOption('zh');
  await expect(promotionRow).toContainText('全场立减 50K');
  await language.selectOption('vi');
  await expect(promotionRow).toContainText('Giảm 50K toàn cửa hàng');
  await language.selectOption('en');
  await expect(promotionRow).toContainText('Storewide VND 50K off');

  await page.getByRole('button', { name: 'Live quote preview' }).click();
  await page.getByLabel('SKU').fill('beauty-local-primary-default');
  const quoteResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes('/v1/pricing/quotes'),
  );
  await page.getByRole('button', { name: 'Get server quote' }).click();
  const response = await quoteResponse;
  expect(response.ok()).toBe(true);
  const quote = (await response.json()) as {
    applied_rules: Array<{ code: string; discount_vnd: number }>;
    base_subtotal_vnd: number;
    discount_vnd: number;
    merchandise_payable_vnd: number;
    order_payable_vnd: null;
    quote_hash: string;
  };
  expect(quote).toMatchObject({
    base_subtotal_vnd: 349_000,
    discount_vnd: 50_000,
    merchandise_payable_vnd: 299_000,
    order_payable_vnd: null,
  });
  expect(quote.applied_rules).toContainEqual(
    expect.objectContaining({ code: promotionCode, discount_vnd: 50_000 }),
  );
  expect(quote.quote_hash).toMatch(/^[a-f0-9]{64}$/);
  await expect(page.locator('.quote-result')).toContainText('beauty-local-primary-default');
  await expect(page.locator('.quote-result')).toContainText(promotionCode);

  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(browserErrors).toEqual([]);
});

test('order workbench schedules audited refunds, provider queries and dead-letter retries in three languages', async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));

  const orderId = '28420000-0000-4000-8000-000000000001';
  const paymentId = '28420000-0000-4000-8000-000000000002';
  const refundId = '28420000-0000-4000-8000-000000000003';
  const jobId = '28420000-0000-4000-8000-000000000004';
  const order = {
    created_at: '2026-07-26T08:00:00.000Z',
    id: orderId,
    items: [],
    order_number: 'ORD-M57-BROWSER',
    payable_vnd: 120_000,
    payment_method: 'ONLINE',
    payment_status: 'SUCCEEDED',
    status: 'PENDING_FULFILLMENT',
    version: 3,
  };
  let refundRequest: Record<string, unknown> | undefined;
  let refundQueryRequest: Record<string, unknown> | undefined;
  let retryRequest: Record<string, unknown> | undefined;
  const idempotencyKeys: string[] = [];

  await page.route('**/v1/admin/orders?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', json: { items: [order] }, status: 200 });
  });
  await page.route(`**/v1/admin/orders/${orderId}?*`, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        ...order,
        address: null,
        cancellation_reason: null,
        note: '',
        refunds: [],
        snapshots: [],
        tags: [],
        transitions: [
          {
            created_at: '2026-07-26T08:00:00.000Z',
            event: 'CREATE',
            from_status: null,
            reason: null,
            to_status: 'PENDING_FULFILLMENT',
          },
        ],
      },
      status: 200,
    });
  });
  await page.route(`**/v1/admin/orders/${orderId}/shipment?*`, async (route) => {
    await route.fulfill({ contentType: 'application/json', json: { shipment: null }, status: 200 });
  });
  await page.route('**/v1/admin/payments?*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        items: [
          {
            amount_vnd: 120_000,
            created_at: '2026-07-26T08:02:00.000Z',
            currency: 'VND',
            expires_at: '2026-07-26T08:12:00.000Z',
            id: paymentId,
            launch_ready: true,
            order_id: orderId,
            payment_number: 'PAY-M57-BROWSER',
            provider_reference_masked: 'za******01',
            status: 'SUCCEEDED',
            transitions: [],
            version: 4,
          },
        ],
        next_cursor: null,
      },
      status: 200,
    });
  });
  await page.route('**/v1/admin/refunds?*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        items: [
          {
            amount_vnd: 50_000,
            currency: 'VND',
            id: refundId,
            payment_id: paymentId,
            provider_refund_reference_masked: 'zr******01',
            public_number: 'RFD-M57-BROWSER',
            reason: 'Browser fixture operator-approved refund',
            requested_at: '2026-07-26T08:05:00.000Z',
            status: 'PROCESSING',
            transitions: [],
            updated_at: '2026-07-26T08:06:00.000Z',
            version: 2,
          },
        ],
        next_cursor: null,
      },
      status: 200,
    });
  });
  await page.route('**/v1/admin/integration-jobs?*', async (route) => {
    const deadLetter = new URL(route.request().url()).searchParams.get('status') === 'DEAD_LETTER';
    await route.fulfill({
      contentType: 'application/json',
      json: {
        items: deadLetter
          ? [
              {
                attempt_count: 1,
                created_at: '2026-07-26T08:07:00.000Z',
                id: jobId,
                last_error_code: 'REFUND_PROVIDER_TIMEOUT',
                next_attempt_at: null,
                operation: 'refund.query.requested',
                status: 'DEAD_LETTER',
                version: 5,
              },
            ]
          : [],
        next_cursor: null,
      },
      status: 200,
    });
  });
  await page.route(`**/v1/admin/payments/${paymentId}/refunds?*`, async (route) => {
    refundRequest = route.request().postDataJSON() as Record<string, unknown>;
    idempotencyKeys.push(route.request().headers()['idempotency-key'] ?? '');
    await route.fulfill({
      contentType: 'application/json',
      json: {
        amount_vnd: refundRequest.amount_vnd,
        currency: 'VND',
        id: randomUUID(),
        payment_id: paymentId,
        public_number: 'RFD-M57-NEW',
        reason: refundRequest.reason,
        requested_at: '2026-07-26T08:10:00.000Z',
        status: 'REQUESTED',
        updated_at: '2026-07-26T08:10:00.000Z',
        version: 1,
      },
      status: 202,
    });
  });
  await page.route(`**/v1/admin/refunds/${refundId}/query?*`, async (route) => {
    refundQueryRequest = route.request().postDataJSON() as Record<string, unknown>;
    idempotencyKeys.push(route.request().headers()['idempotency-key'] ?? '');
    await route.fulfill({
      contentType: 'application/json',
      json: {
        attempt_count: 0,
        created_at: '2026-07-26T08:11:00.000Z',
        id: randomUUID(),
        last_error_code: null,
        next_attempt_at: '2026-07-26T08:11:00.000Z',
        operation: 'refund.query.requested',
        status: 'PENDING',
        version: 1,
      },
      status: 202,
    });
  });
  await page.route(`**/v1/admin/integration-jobs/${jobId}/retry?*`, async (route) => {
    retryRequest = route.request().postDataJSON() as Record<string, unknown>;
    idempotencyKeys.push(route.request().headers()['idempotency-key'] ?? '');
    await route.fulfill({
      contentType: 'application/json',
      json: {
        attempt_count: 0,
        created_at: '2026-07-26T08:07:00.000Z',
        id: jobId,
        last_error_code: null,
        next_attempt_at: '2026-07-26T08:12:00.000Z',
        operation: 'refund.query.requested',
        status: 'PENDING',
        version: 6,
      },
      status: 202,
    });
  });

  await signIn(page);
  await page.getByRole('button', { name: 'Orders & COD' }).click();
  await expect(page.getByRole('heading', { name: 'Orders & shipping' })).toBeVisible();
  await page.getByRole('button', { name: /ORD-M57-BROWSER/ }).click();
  await expect(page.getByText('PAY-M57-BROWSER', { exact: true })).toBeVisible();
  await expect(page.locator('.admin-finance')).toContainText('70.000 ₫');
  await expect(page.locator('.integration-job-panel')).toContainText('REFUND_PROVIDER_TIMEOUT');

  await page.getByRole('button', { name: 'Create refund' }).click();
  let form = page.locator('form.shipment-operation-dialog');
  await form.getByLabel(/Refund amount/).fill('30000');
  await form.getByLabel(/CREATE_REFUND/).fill('CREATE_REFUND');
  await form.getByRole('button', { name: 'Confirm action' }).click();
  await expect(page.locator('.admin-finance')).toContainText('The financial request was recorded');
  expect(refundRequest).toMatchObject({
    amount_vnd: 30_000,
    confirmation_code: 'CREATE_REFUND',
    expected_payment_version: 4,
  });
  expect(refundRequest).not.toHaveProperty('provider_refund_id');

  await page.getByRole('button', { name: 'Query refund' }).click();
  form = page.locator('form.shipment-operation-dialog');
  await form.getByRole('button', { name: 'Confirm action' }).click();
  expect(refundQueryRequest).toMatchObject({ expected_version: 2 });

  await page.getByRole('button', { name: 'Retry dead letter' }).click();
  form = page.locator('form.shipment-operation-dialog');
  await form.getByLabel(/RETRY_DEAD_LETTER/).fill('RETRY_DEAD_LETTER');
  await form.getByRole('button', { name: 'Confirm action' }).click();
  expect(retryRequest).toMatchObject({
    confirmation_code: 'RETRY_DEAD_LETTER',
    expected_version: 5,
  });
  expect(idempotencyKeys).toHaveLength(3);
  expect(idempotencyKeys.every((key) => /^[0-9a-f-]{36}$/u.test(key))).toBe(true);

  const language = page.getByLabel('Language');
  await language.selectOption('zh');
  await expect(page.getByRole('heading', { name: '支付与退款' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '需关注的集成任务' })).toBeVisible();
  await language.selectOption('vi');
  await expect(page.getByRole('heading', { name: 'Thanh toán & hoàn tiền' })).toBeVisible();
  await language.selectOption('en');
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(browserErrors).toEqual([]);
});

test('financial reconciliation stays store-scoped, redacted and operable in three languages', async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));

  const batchId = '50000000-0000-4000-8000-000000000001';
  const fullProviderReference = 'zalo-provider-reference-must-not-render';
  const batch = {
    batch_reference_masked: 'se********01',
    business_date: '2026-08-01',
    created_at: '2026-08-01T03:00:00.000Z',
    currency: 'VND',
    difference_vnd: 0,
    exception_count: 0,
    fee_amount_vnd: 2_000,
    gross_amount_vnd: 120_000,
    id: batchId,
    local_expected_amount_vnd: 120_000,
    matched_count: 1,
    net_amount_vnd: 118_000,
    record_count: 1,
    source: 'PAYMENT_PROVIDER',
    status: 'MATCHED',
    version: 1,
  };
  const detail = {
    ...batch,
    lines: [
      {
        difference_vnd: 0,
        fee_amount_vnd: 2_000,
        gross_amount_vnd: 120_000,
        id: '50000000-0000-4000-8000-000000000002',
        line_number: 1,
        local_expected_amount_vnd: 120_000,
        net_amount_vnd: 118_000,
        occurred_at: '2026-08-01T02:30:00.000Z',
        provider_reference_masked: 'za********er',
        record_reference_masked: 'li******01',
        status: 'MATCHED',
        type: 'PAYMENT',
      },
    ],
    replayed: false,
  };
  let importRequest: Record<string, unknown> | undefined;
  let importIdempotencyKey = '';

  await page.route('**/v1/admin/financial-reconciliation/batches?*', async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      contentType: 'application/json',
      json:
        url.searchParams.get('store_id') === BEAUTY_STORE_ID
          ? { items: [batch], next_cursor: null }
          : { items: [], next_cursor: null },
      status: 200,
    });
  });
  await page.route(`**/v1/admin/financial-reconciliation/batches/${batchId}?*`, async (route) => {
    await route.fulfill({ contentType: 'application/json', json: detail, status: 200 });
  });
  await page.route('**/v1/admin/financial-reconciliation/payment-batches?*', async (route) => {
    importRequest = route.request().postDataJSON() as Record<string, unknown>;
    importIdempotencyKey = route.request().headers()['idempotency-key'] ?? '';
    await route.fulfill({ contentType: 'application/json', json: detail, status: 201 });
  });

  await signIn(page);
  await page.getByRole('button', { name: 'Financial reconciliation' }).click();
  await expect(page.getByRole('heading', { name: 'Financial reconciliation' })).toBeVisible();
  await expect(page.locator('.reconciliation-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.reconciliation-workbench')).not.toContainText(fullProviderReference);

  await page.getByRole('button', { name: 'View details' }).click();
  await expect(page.locator('.reconciliation-detail')).toContainText('za********er');
  await expect(page.locator('.reconciliation-detail')).not.toContainText(fullProviderReference);

  const language = page.getByLabel('Language');
  await language.selectOption('zh');
  await expect(page.getByRole('heading', { name: '财务对账' })).toBeVisible();
  await expect(page.locator('.reconciliation-detail')).toContainText('已匹配');
  await language.selectOption('vi');
  await expect(page.getByRole('heading', { name: 'Đối soát tài chính' })).toBeVisible();
  await language.selectOption('en');

  const storeSelect = page.getByLabel('Select store');
  await storeSelect.selectOption(FASHION_STORE_ID);
  await expect(page.locator('.reconciliation-workbench')).toContainText(
    'No financial reconciliation batches exist in this scope.',
  );
  await storeSelect.selectOption(BEAUTY_STORE_ID);
  await expect(page.locator('.reconciliation-table tbody tr')).toHaveCount(1);

  await page.getByRole('button', { name: 'Import batch' }).click();
  const form = page.locator('.reconciliation-import form');
  await form.getByLabel('Batch reference').fill('settlement-browser-001');
  await form.getByLabel('Import reason').fill('Finance reviewed the normalized browser statement');
  await form.getByLabel('Record reference').fill('statement-line-browser-001');
  await form.getByLabel('Provider reference').fill('provider-browser-001');
  await form.getByLabel('Gross').fill('120000');
  await form.getByLabel('Fee').fill('2000');
  await form.getByLabel('I confirm finance reviewed this normalized data.').check();
  const importResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes('/v1/admin/financial-reconciliation/payment-batches'),
  );
  await form.getByRole('button', { name: 'Record reconciliation batch' }).click();
  expect((await importResponse).status()).toBe(201);
  expect(importRequest).toMatchObject({
    batch_reference: 'settlement-browser-001',
    confirmation_code: 'IMPORT_PAYMENT_SETTLEMENT',
    provider_code: 'ZALO_CHECKOUT_ZALOPAY',
    provider_environment: 'SANDBOX',
    records: [
      expect.objectContaining({
        fee_amount_vnd: 2_000,
        gross_amount_vnd: 120_000,
        provider_reference: 'provider-browser-001',
        record_reference: 'statement-line-browser-001',
        type: 'PAYMENT',
      }),
    ],
  });
  expect(importRequest).not.toHaveProperty('store_id');
  expect(importRequest).not.toHaveProperty('payment_status');
  expect(importIdempotencyKey).toMatch(/^financial-reconciliation:[0-9a-f-]{36}$/u);
  await expect(page.locator('.reconciliation-workbench')).toContainText(
    'The reconciliation batch was recorded.',
  );

  await page.setViewportSize({ height: 900, width: 640 });
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(browserErrors).toEqual([]);
});
