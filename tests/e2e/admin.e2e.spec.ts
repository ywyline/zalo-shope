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
