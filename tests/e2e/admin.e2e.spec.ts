import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import writeXlsxFile, { type SheetData } from 'write-excel-file/node';

import { generateTotp } from '@zalo-shop/security';

import { PRODUCT_IMPORT_COLUMNS } from '../../apps/api/src/catalog-admin/product-import';

const ADMIN_URL = 'http://127.0.0.1:5173/';
const BEAUTY_STORE_ID = '10000000-0000-4000-8000-000000000001';
const FASHION_STORE_ID = '10000000-0000-4000-8000-000000000002';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type E2eCredentials = { email: string; password: string; totpSecret: string };

function credentials(): E2eCredentials {
  const serialized = process.env.ZALO_SHOP_E2E_ADMIN;
  if (!serialized) throw new Error('ZALO_SHOP_E2E_ADMIN was not prepared by global setup');
  return JSON.parse(serialized) as E2eCredentials;
}

async function signIn(page: Page): Promise<void> {
  const account = credentials();
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

test('inventory workbench stays isolated and validates an atomic initial-load file', async ({
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
