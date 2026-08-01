import { expect, test, type Page } from '@playwright/test';

import {
  setM37BrowserPrimarySkuPrice,
  setM37BrowserPrimarySkuStock,
} from '../fixtures/m26-browser-fixture';

const storefronts = [
  {
    code: 'beauty-local',
    extraSku: 'beauty-local-primary-extra',
    industry: 'beauty',
    initialPrice: 349_000,
    names: { en: 'Beauty Store', vi: 'Cửa hàng Mỹ phẩm', zh: '美妆商城' },
    otherProduct: 'Sơ mi linen thoáng nhẹ',
    product: 'Tinh chất Sương Mai',
    productCode: 'dew-renewal-serum',
    productEn: 'Dew Renewal Serum',
    primarySku: 'beauty-local-primary-default',
    productZh: '晨露焕新精华',
    titles: { en: 'Glow, softly', vi: 'Rạng rỡ thật dịu dàng', zh: '温柔焕亮' },
    url: `http://127.0.0.1:${process.env.E2E_BEAUTY_MINI_APP_PORT ?? '5174'}/`,
  },
  {
    code: 'fashion-local',
    extraSku: 'fashion-local-primary-extra',
    industry: 'fashion',
    initialPrice: 659_000,
    names: { en: 'Fashion Store', vi: 'Cửa hàng Thời trang', zh: '服装商城' },
    otherProduct: 'Tinh chất Sương Mai',
    product: 'Sơ mi linen thoáng nhẹ',
    productCode: 'air-linen-shirt',
    productEn: 'Air Linen Shirt',
    primarySku: 'fashion-local-primary-default',
    productZh: '轻盈亚麻衬衫',
    titles: { en: 'The new ease', vi: 'Thanh lịch thật tự nhiên', zh: '自在新廓形' },
    url: 'http://127.0.0.1:5175/',
  },
] as const;

type ZaloTokenMatrix = Record<string, Record<string, string>>;

function zaloTokens(projectName: string): Record<string, string> {
  const serialized = process.env.ZALO_SHOP_E2E_ZALO_TOKENS;
  if (!serialized) throw new Error('Zalo browser tokens were not prepared by global setup');
  const tokens = (JSON.parse(serialized) as ZaloTokenMatrix)[projectName];
  if (!tokens?.['beauty-local'] || !tokens['fashion-local']) {
    throw new Error(`Zalo browser tokens are missing for ${projectName}`);
  }
  return tokens;
}

async function installZaloBridge(
  page: Page,
  projectName: string,
  checkout?: { paymentDoneDelayMs: number; providerOrderId: string },
): Promise<void> {
  const tokens = zaloTokens(projectName);
  await page.addInitScript(
    ({ beautyToken, checkoutOptions, fashionToken }) => {
      const paymentDoneListeners = new Set<(data: unknown) => void>();
      const bridgeWindow = window as Window & {
        __ZALO_SHOP_E2E_BRIDGE__?: {
          checkoutCheckTransaction(data: { orderId: string }): unknown;
          checkoutCreateOrder(payload: Record<string, unknown>): Promise<{ orderId: string }>;
          checkoutOffPaymentDone(listener: (data: unknown) => void): void;
          checkoutOnPaymentDone(listener: (data: unknown) => void): void;
          getAccessToken(): string;
        };
        __ZALO_SHOP_E2E_PAYMENT_CALLS__?: {
          checks: Array<{ orderId: string }>;
          payloads: Array<Record<string, unknown>>;
        };
      };
      const calls = {
        checks: [] as Array<{ orderId: string }>,
        payloads: [] as Array<Record<string, unknown>>,
      };
      bridgeWindow.__ZALO_SHOP_E2E_PAYMENT_CALLS__ = calls;
      bridgeWindow.__ZALO_SHOP_E2E_BRIDGE__ = {
        checkoutCheckTransaction: (data) => {
          calls.checks.push(data);
          return { resultCode: 0 };
        },
        checkoutCreateOrder: (payload) => {
          calls.payloads.push(payload);
          window.setTimeout(
            () =>
              paymentDoneListeners.forEach((listener) => listener({ completedOrCancelled: true })),
            checkoutOptions?.paymentDoneDelayMs ?? 0,
          );
          return Promise.resolve({
            orderId: checkoutOptions?.providerOrderId ?? 'e2e-checkout-order',
          });
        },
        checkoutOffPaymentDone: (listener) => paymentDoneListeners.delete(listener),
        checkoutOnPaymentDone: (listener) => paymentDoneListeners.add(listener),
        getAccessToken: () => (window.location.port === '5175' ? fashionToken : beautyToken),
      };
    },
    {
      beautyToken: tokens['beauty-local'],
      checkoutOptions: checkout,
      fashionToken: tokens['fashion-local'],
    },
  );
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
}

test('buyer catalog is isolated and complete in all three languages', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));

  for (const store of storefronts) {
    await page.goto(store.url);
    await expect(page.getByRole('heading', { name: store.titles.vi })).toBeVisible();
    await expect(page.getByText(store.names.vi, { exact: true })).toBeVisible();
    await expect(page.getByText(store.product, { exact: true })).toBeVisible();
    await expect(page.getByText(store.otherProduct, { exact: true })).toHaveCount(0);
    expect(await page.locator('html').getAttribute('data-industry')).toBe(store.industry);

    await page.getByRole('button', { name: 'ZH', exact: true }).click();
    await expect(page.getByRole('heading', { name: store.titles.zh })).toBeVisible();
    await expect(page.getByText(store.names.zh, { exact: true })).toBeVisible();
    await expect(page.getByText(store.productZh, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.getByRole('heading', { name: store.titles.en })).toBeVisible();
    await expect(page.getByText(store.names.en, { exact: true })).toBeVisible();
    await expect(page.getByText(store.productEn, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'VI', exact: true }).click();
    await page.getByText(store.product, { exact: true }).click();
    await expect(page.getByRole('heading', { name: store.product })).toBeVisible();
    await expect(page.getByRole('radio').first()).toBeVisible();
    await expect(page.getByText('Còn có thể đặt: 12', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }

  expect(browserErrors).toEqual([]);
});

test('buyer catalog exposes a recoverable localized error state', async ({ page }) => {
  let rejectHome = true;
  await page.route('**/v1/catalog/home?*', async (route) => {
    if (rejectHome) await route.abort('failed');
    else await route.continue();
  });

  await page.goto(storefronts[0].url);
  await expect(page.getByRole('alert')).toContainText('Không thể tải nội dung lúc này.');
  rejectHome = false;
  await page.getByRole('button', { name: 'Tải lại' }).click();
  await expect(page.getByRole('heading', { name: storefronts[0].titles.vi })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('buyer search supports accent folding, three languages and mobile filters per store', async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));

  for (const store of storefronts) {
    await page.goto(`${store.url}#/search`);
    const searchbox = page.getByRole('searchbox');
    await expect(searchbox).toBeVisible();
    await searchbox.fill(store.industry === 'beauty' ? 'suong mai' : 'so mi linen');
    await page.getByRole('button', { name: 'Tìm kiếm', exact: true }).click();
    await expect(page.getByText(store.product, { exact: true })).toBeVisible();
    await expect(page.getByText(store.otherProduct, { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'ZH', exact: true }).click();
    await searchbox.fill(store.industry === 'beauty' ? '晨露' : '亚麻');
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await expect(page.getByText(store.productZh, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await searchbox.fill(store.industry === 'beauty' ? 'renewal serum' : 'linen shirt');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByText(store.productEn, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'VI', exact: true }).click();
    await searchbox.fill('');
    await page.getByRole('button', { name: 'Tìm kiếm', exact: true }).click();
    await page.getByRole('button', { name: 'Bộ lọc', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Bộ lọc' });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole('checkbox', { name: store.industry === 'beauty' ? /Hồng/ : /^L\s/ })
      .check();
    await dialog.getByRole('button', { name: 'Áp dụng bộ lọc', exact: true }).click();
    await expect(page.getByText(store.product, { exact: true })).toBeVisible();
    await expect(
      page.getByText(store.industry === 'beauty' ? 'Son cánh hoa nhung' : 'Đầm suông ban ngày', {
        exact: true,
      }),
    ).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  }

  expect(browserErrors).toEqual([]);
});

test('authenticated buyer cart is isolated, localized and revalidates mutable facts', async ({
  page,
}, testInfo) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await installZaloBridge(page, testInfo.project.name);

  for (const store of storefronts) {
    await page.goto(`${store.url}#/products/${store.productCode}`);
    await expect(page.getByRole('heading', { name: store.product })).toBeVisible();
    const addButton = page.getByRole('button', { name: 'Thêm vào giỏ', exact: true });
    await expect(addButton).toBeEnabled();
    const addResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().includes(`/v1/cart/items/by-sku/${store.primarySku}`),
    );
    await addButton.click();
    expect((await addResponse).ok()).toBe(true);
    await expect(page.locator('.purchase-dock .dock-count')).toHaveText('1');

    await page
      .locator('.purchase-dock')
      .getByRole('link', { name: /Giỏ hàng/ })
      .click();
    await expect(page.getByRole('heading', { name: 'Giỏ hàng', exact: true })).toBeVisible();
    const line = page.locator('.cart-line').first();
    await expect(page.locator('.cart-line')).toHaveCount(1);
    await expect(line).toContainText(store.product);

    const increaseResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' && response.url().includes('/v1/cart/items/'),
    );
    await line.getByRole('button', { name: 'Tăng số lượng' }).click();
    expect((await increaseResponse).ok()).toBe(true);
    await expect(line.locator('.quantity-control span')).toHaveText('2');

    const selected = line.getByRole('checkbox');
    const deselectResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' && response.url().includes('/v1/cart/items/'),
    );
    await selected.click();
    expect((await deselectResponse).ok()).toBe(true);
    await expect(selected).not.toBeChecked();
    await expect(page.locator('.cart-total strong')).toContainText('0');
    const selectResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' && response.url().includes('/v1/cart/items/'),
    );
    await selected.click();
    expect((await selectResponse).ok()).toBe(true);
    await expect(selected).toBeChecked();

    const skuSelect = line.getByLabel('Đổi phiên bản');
    const replaceWithExtraResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' && response.url().includes('/v1/cart/items/'),
    );
    await skuSelect.selectOption(store.extraSku);
    const extraResponse = await replaceWithExtraResponse;
    expect(extraResponse.ok()).toBe(true);
    expect(
      ((await extraResponse.json()) as { items: Array<{ sku_code: string }> }).items.some(
        (item) => item.sku_code === store.extraSku,
      ),
    ).toBe(true);
    await expect(skuSelect).toHaveValue(store.extraSku);
    const replaceWithPrimaryResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' && response.url().includes('/v1/cart/items/'),
    );
    await skuSelect.selectOption(store.primarySku);
    const primaryResponse = await replaceWithPrimaryResponse;
    expect(primaryResponse.ok()).toBe(true);
    expect(
      ((await primaryResponse.json()) as { items: Array<{ sku_code: string }> }).items.some(
        (item) => item.sku_code === store.primarySku,
      ),
    ).toBe(true);
    await expect(skuSelect).toHaveValue(store.primarySku);

    await page.getByRole('button', { name: 'ZH', exact: true }).click();
    await expect(line).toContainText(store.productZh);
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(line).toContainText(store.productEn);
    await page.getByRole('button', { name: 'VI', exact: true }).click();
    await expect(line).toContainText(store.product);

    const originalPrice = await setM37BrowserPrimarySkuPrice(
      store.code,
      store.initialPrice + 17_000,
    );
    let originalStock: number | undefined;
    try {
      originalStock = await setM37BrowserPrimarySkuStock(store.code, 0);
      await page.getByRole('button', { name: 'EN', exact: true }).click();
      await expect(line).toContainText('Out of stock');
      await expect(line).toContainText('The price changed and was recalculated');
      await expect(page.getByRole('alert')).toContainText('Some items need attention');
    } finally {
      if (originalStock !== undefined) {
        await setM37BrowserPrimarySkuStock(store.code, originalStock);
      }
      await setM37BrowserPrimarySkuPrice(store.code, originalPrice);
    }

    await page.getByRole('button', { name: 'VI', exact: true }).click();
    await expect(line.locator('.cart-issues')).toHaveCount(0);
    const removeResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' && response.url().includes('/v1/cart/items/'),
    );
    await line.getByRole('button', { name: 'Xóa', exact: true }).click();
    expect((await removeResponse).status()).toBe(204);
    await expect(page.getByText('Giỏ hàng của bạn đang trống.', { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
    ).toEqual({ local: 0, session: 0 });
    await expectNoHorizontalOverflow(page);
  }

  expect(browserErrors).toEqual([]);
});

test('authenticated buyer creates an address, places one idempotent COD order and cancels it', async ({
  page,
}, testInfo) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await installZaloBridge(page, testInfo.project.name);
  const store = storefronts[0];

  await page.goto(`${store.url}#/addresses`);
  await expect(page.getByRole('heading', { name: 'Địa chỉ nhận hàng' })).toBeVisible();
  await page.getByRole('button', { name: /Thêm địa chỉ/ }).click();
  await page.getByLabel('Người nhận').fill('Nguyen E2E');
  await page.getByLabel('Số điện thoại').fill('+84901234567');
  const areaSelectors = page.locator('.address-form select');
  await areaSelectors.nth(0).selectOption('hcm');
  await areaSelectors.nth(1).selectOption('quan-1');
  await areaSelectors.nth(2).selectOption('ben-nghe');
  await page.getByLabel('Địa chỉ chi tiết').fill('12 Le Loi');
  await page.getByLabel('Nhãn địa chỉ').fill('Nhà');
  await page.getByLabel('Địa chỉ mặc định').check();
  const addressResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes('/v1/member/addresses'),
  );
  await page.getByRole('button', { name: 'Lưu địa chỉ' }).click();
  expect((await addressResponse).status()).toBe(201);
  await expect(page.getByText('Nguyen E2E', { exact: true })).toBeVisible();

  await page.goto(`${store.url}#/products/${store.productCode}`);
  const addResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      response.url().includes(`/v1/cart/items/by-sku/${store.primarySku}`),
  );
  await page.getByRole('button', { name: 'Thêm vào giỏ', exact: true }).click();
  expect((await addResponse).ok()).toBe(true);
  await page.goto(`${store.url}#/cart`);
  const quoteResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes('/v1/checkout/quote'),
  );
  await page.getByRole('link', { name: 'Tiếp tục thanh toán' }).click();
  const quoteResponse = await quoteResponsePromise;
  expect(quoteResponse.ok()).toBe(true);
  const quote = (await quoteResponse.json()) as { order_payable_vnd: number };
  expect(quote.order_payable_vnd).toBeGreaterThan(0);
  await expect(page.getByRole('heading', { name: 'Xác nhận đơn hàng' })).toBeVisible();
  await expect(page.getByText('Thanh toán khi nhận hàng', { exact: true })).toBeVisible();
  await expect(page.locator('.checkout-total')).toContainText(
    new Intl.NumberFormat('vi-VN').format(quote.order_payable_vnd),
  );

  const orderResponses: Array<{ id: string; status: number }> = [];
  page.on('response', async (response) => {
    if (response.request().method() === 'POST' && response.url().includes('/v1/checkout/orders')) {
      const body = (await response.json()) as { id?: string };
      if (body.id) orderResponses.push({ id: body.id, status: response.status() });
    }
  });
  const placeOrder = page.getByRole('button', { name: 'Đặt hàng COD' });
  await placeOrder.evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect(page.getByRole('heading', { name: 'Đặt hàng thành công' })).toBeVisible();
  await expect.poll(() => orderResponses.length).toBeGreaterThan(0);
  expect(new Set(orderResponses.map(({ id }) => id)).size).toBe(1);
  expect(orderResponses.every(({ status }) => status === 201)).toBe(true);
  const orderId = orderResponses[0]!.id;

  await page.route(`**/v1/orders/${orderId}`, async (route) => {
    const response = await route.fetch();
    const detail = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      contentType: 'application/json',
      json: {
        ...detail,
        refunds: [
          {
            amount_vnd: 25_000,
            public_number: 'RFD-BROWSER-0001',
            requested_at: '2026-07-26T09:00:00.000Z',
            status: 'SUCCEEDED',
            updated_at: '2026-07-26T10:00:00.000Z',
          },
        ],
      },
      status: response.status(),
    });
  });

  await page.getByRole('link', { name: 'Xem đơn hàng' }).click();
  await expect(page.locator('.page-intro .order-status')).toHaveText('Chờ xác nhận');
  const refundPanel = page.locator('.refund-status-panel');
  await expect(refundPanel.getByRole('heading', { name: 'Hoàn tiền' })).toBeVisible();
  await expect(refundPanel).toContainText('RFD-BROWSER-0001');
  await expect(refundPanel).toContainText('Đã hoàn tiền');
  await expect(refundPanel).not.toContainText('provider');
  await expect(page.locator('.shipment-tracking')).toContainText('Đơn hàng chưa có vận đơn.');
  await page.route(`**/v1/orders/${orderId}/shipment`, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        shipment: {
          created_at: '2026-07-26T10:00:00.000Z',
          delivered_at: null,
          public_number: 'SHIP_BROWSER_0001',
          status: 'CANCELLED',
          tracking_events: [
            {
              location_masked: 'Quận 1',
              message_key: 'shipment.tracking.cancelled',
              occurred_at: '2026-07-26T10:05:00.000Z',
              status: 'CANCELLED',
            },
          ],
          updated_at: '2026-07-26T10:05:00.000Z',
        },
      },
      status: 200,
    });
  });
  await page.getByLabel('Lý do hủy').fill('Kiểm tra hủy đơn E2E');
  const cancelResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes('/cancel'),
  );
  await page.getByRole('button', { name: 'Hủy đơn hàng' }).click();
  expect((await cancelResponse).status()).toBe(201);
  await expect(page.locator('.page-intro .order-status')).toHaveText('Đã hủy');
  const tracking = page.locator('.shipment-tracking');
  await expect(tracking.getByRole('heading', { name: 'Theo dõi giao hàng' })).toBeVisible();
  await expect(tracking).toContainText('Đã hủy vận đơn');
  await expect(tracking).toContainText('Vận đơn đã được hủy.');
  await page.getByRole('button', { name: 'ZH', exact: true }).click();
  await expect(refundPanel.getByRole('heading', { name: '退款进度' })).toBeVisible();
  await expect(refundPanel).toContainText('退款成功');
  await expect(tracking.getByRole('heading', { name: '物流跟踪' })).toBeVisible();
  await expect(tracking).toContainText('运单已取消。');
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(refundPanel.getByRole('heading', { name: 'Refunds' })).toBeVisible();
  await expect(refundPanel).toContainText('Refunded');
  await expect(tracking.getByRole('heading', { name: 'Shipment tracking' })).toBeVisible();
  await expect(tracking).toContainText('The shipment was cancelled.');
  await page.getByRole('button', { name: 'VI', exact: true }).click();

  await page.goto(`${store.url}#/orders`);
  await expect(page.getByRole('heading', { name: 'Đơn hàng của tôi' })).toBeVisible();
  await expect(page.locator('.order-card')).toHaveCount(1);
  await expect(page.locator('.order-card')).toContainText('Đã hủy');
  await page.getByRole('button', { name: 'ZH', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的订单' })).toBeVisible();
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My orders' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect(browserErrors).toEqual([]);
});

test('buyer online payment launches only by user action and recovers from server facts', async ({
  page,
}, testInfo) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));

  const orderId = '10000000-0000-4000-8000-000000000001';
  const paymentId = '20000000-0000-4000-8000-000000000001';
  const retryPaymentId = '20000000-0000-4000-8000-000000000002';
  const providerOrderId = 'zalo-checkout-e2e-order-1';
  const launchToken = 'online-payment-e2e-launch-token-0001';
  const store = storefronts[0];
  await installZaloBridge(page, testInfo.project.name, {
    paymentDoneDelayMs: 1_000,
    providerOrderId,
  });

  await page.goto(`${store.url}#/addresses`);
  await page.getByRole('button', { name: /Thêm địa chỉ/ }).click();
  await page.getByLabel('Người nhận').fill('Nguyen Online');
  await page.getByLabel('Số điện thoại').fill('+84901234569');
  const areaSelectors = page.locator('.address-form select');
  await areaSelectors.nth(0).selectOption('hcm');
  await areaSelectors.nth(1).selectOption('quan-1');
  await areaSelectors.nth(2).selectOption('ben-nghe');
  await page.getByLabel('Địa chỉ chi tiết').fill('18 Nguyen Hue');
  await page.getByLabel('Nhãn địa chỉ').fill('Online');
  const addressResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes('/v1/member/addresses'),
  );
  await page.getByRole('button', { name: 'Lưu địa chỉ' }).click();
  expect((await addressResponse).status()).toBe(201);

  await page.goto(`${store.url}#/products/${store.productCode}`);
  const addResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      response.url().includes(`/v1/cart/items/by-sku/${store.primarySku}`),
  );
  await page.getByRole('button', { name: 'Thêm vào giỏ', exact: true }).click();
  expect((await addResponse).ok()).toBe(true);

  let checkoutRequest: Record<string, unknown> | undefined;
  let bindRequest: Record<string, unknown> | undefined;
  let bindIdempotencyKey = '';
  let retryIdempotencyKey = '';
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const payment = {
    amount_vnd: store.initialPrice + 30_000,
    created_at: new Date().toISOString(),
    currency: 'VND',
    expires_at: expiresAt,
    id: paymentId,
    launch_ready: true,
    order_id: orderId,
    payment_number: 'PAY-E2E-ONLINE-1',
    provider_order_bound: false,
    status: 'CREATED',
    transitions: [],
    version: 1,
  };
  const retryAttempt = {
    ...payment,
    id: retryPaymentId,
    launch_ready: false,
    payment_number: 'PAY-E2E-ONLINE-2',
    provider_order_bound: false,
    status: 'CREATED',
    version: 1,
  };

  await page.route('**/v1/checkout/quote', async (route) => {
    const request = route.request().postDataJSON() as Record<string, unknown>;
    if (request.payment_method !== 'ONLINE') {
      await route.continue();
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      json: {
        base_subtotal_vnd: store.initialPrice,
        cod_policy: { enabled: true, max_amount_vnd: null },
        discount_vnd: 0,
        lines: [{ payable_vnd: store.initialPrice, quantity: 1, sku_code: store.primarySku }],
        merchandise_payable_vnd: store.initialPrice,
        order_payable_vnd: payment.amount_vnd,
        quote_hash: 'a'.repeat(64),
        remote_surcharge_vnd: 0,
        shipping_discount_vnd: 0,
        shipping_fee_vnd: 30_000,
      },
      status: 201,
    });
  });
  await page.route('**/v1/checkout/orders', async (route) => {
    checkoutRequest = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      contentType: 'application/json',
      json: {
        created_at: new Date().toISOString(),
        id: orderId,
        items: [],
        order_number: 'ORD-E2E-ONLINE-1',
        payable_vnd: payment.amount_vnd,
        payment_attempt_id: paymentId,
        payment_method: 'ONLINE',
        payment_status: 'PENDING',
        status: 'PENDING_PAYMENT',
      },
      status: 201,
    });
  });
  await page.route(`**/v1/payments/${paymentId}`, async (route) => {
    await route.fulfill({ contentType: 'application/json', json: payment, status: 200 });
  });
  await page.route(`**/v1/payments/${paymentId}/launch`, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        expires_at: expiresAt,
        kind: 'ZALO_CHECKOUT_CREATE_ORDER',
        launch_token: launchToken,
        payload: {
          amount: payment.amount_vnd,
          desc: 'ORD-E2E-ONLINE-1',
          extradata: launchToken,
          item: [{ amount: store.initialPrice, id: store.primarySku }],
          mac: 'b'.repeat(64),
          method: '{"id":"ZALOPAY_SANDBOX","isCustom":false}',
        },
        payment_id: paymentId,
      },
      status: 200,
    });
  });
  await page.route(
    `**/v1/orders/${orderId}/payments/${paymentId}/provider-order`,
    async (route) => {
      bindRequest = route.request().postDataJSON() as Record<string, unknown>;
      bindIdempotencyKey = route.request().headers()['idempotency-key'] ?? '';
      payment.provider_order_bound = true;
      payment.status = 'PROVIDER_PENDING';
      payment.version += 1;
      await route.fulfill({ contentType: 'application/json', json: payment, status: 201 });
    },
  );
  await page.route(`**/v1/payments/${paymentId}/query`, async (route) => {
    payment.status = 'SUCCEEDED';
    payment.version += 1;
    await route.fulfill({ contentType: 'application/json', json: payment, status: 201 });
  });
  await page.route(`**/v1/orders/${orderId}/payments`, async (route) => {
    retryIdempotencyKey = route.request().headers()['idempotency-key'] ?? '';
    await route.fulfill({ contentType: 'application/json', json: retryAttempt, status: 201 });
  });
  await page.route(`**/v1/payments/${retryPaymentId}`, async (route) => {
    await route.fulfill({ contentType: 'application/json', json: retryAttempt, status: 200 });
  });

  await page.goto(`${store.url}#/cart`);
  await page.getByRole('link', { name: 'Tiếp tục thanh toán' }).click();
  await expect(page.getByRole('heading', { name: 'Xác nhận đơn hàng' })).toBeVisible();
  const onlineQuote = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes('/v1/checkout/quote') &&
      response.request().postData()?.includes('"payment_method":"ONLINE"') === true,
  );
  await page.getByRole('button', { name: 'Thanh toán trực tuyến' }).click();
  expect((await onlineQuote).status()).toBe(201);
  await expect(page.locator('.checkout-total')).toContainText(
    new Intl.NumberFormat('vi-VN').format(payment.amount_vnd),
  );
  await page.getByRole('button', { name: 'Đặt hàng và thanh toán' }).click();
  await expect(page.getByRole('heading', { name: 'Sẵn sàng thanh toán' })).toBeVisible();
  expect(checkoutRequest).toMatchObject({ payment_method: 'ONLINE', quote_hash: 'a'.repeat(64) });

  const callsBeforeClick = await page.evaluate(
    () =>
      (
        window as Window & {
          __ZALO_SHOP_E2E_PAYMENT_CALLS__?: { payloads: unknown[] };
        }
      ).__ZALO_SHOP_E2E_PAYMENT_CALLS__?.payloads.length ?? -1,
  );
  expect(callsBeforeClick).toBe(0);
  await page.getByRole('button', { name: 'Thanh toán với ZaloPay' }).click();
  await expect(page.getByRole('heading', { name: 'Đang xác nhận thanh toán' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Thanh toán thành công' })).toBeVisible();
  expect(bindRequest).toEqual({ launch_token: launchToken, provider_order_id: providerOrderId });
  expect(bindIdempotencyKey.length).toBeGreaterThanOrEqual(16);
  const sdkCalls = await page.evaluate(
    () =>
      (
        window as Window & {
          __ZALO_SHOP_E2E_PAYMENT_CALLS__?: {
            checks: Array<{ orderId: string }>;
            payloads: Array<Record<string, unknown>>;
          };
        }
      ).__ZALO_SHOP_E2E_PAYMENT_CALLS__,
  );
  expect(sdkCalls?.payloads).toHaveLength(1);
  expect(sdkCalls?.payloads[0]).toMatchObject({ amount: payment.amount_vnd, mac: 'b'.repeat(64) });
  expect(sdkCalls?.checks).toEqual([{ orderId: providerOrderId }]);

  await page.getByRole('button', { name: 'ZH', exact: true }).click();
  await expect(page.getByRole('heading', { name: '支付成功' })).toBeVisible();
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Payment successful' })).toBeVisible();
  await page.getByRole('button', { name: 'VI', exact: true }).click();

  payment.status = 'FAILED';
  payment.version += 1;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Thanh toán chưa thành công' })).toBeVisible();
  await page.getByRole('button', { name: 'Tạo lần thanh toán mới' }).click();
  await expect(page.getByRole('heading', { name: 'Đang chuẩn bị thanh toán' })).toBeVisible();
  expect(retryIdempotencyKey.length).toBeGreaterThanOrEqual(16);
  await expectNoHorizontalOverflow(page);
  expect(browserErrors).toEqual([]);
});

test('buyer cart keeps an explicit recoverable Zalo sign-in state on web preview', async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));

  await page.goto(`${storefronts[0].url}#/cart`);
  await expect(page.getByRole('heading', { name: 'Giỏ hàng', exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Kết nối để dùng giỏ hàng', exact: true }),
  ).toBeVisible();
  const connect = page.getByRole('button', { name: 'Kết nối Zalo' });
  await expect(connect).toBeVisible();
  await connect.click();
  await expect(page.getByText('Không thể xác minh Zalo.', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'ZH', exact: true }).click();
  await expect(page.getByRole('heading', { name: '连接后使用购物车' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect(browserErrors).toEqual([]);
});

test('profile phone controls expose clear selected and fallback states', async ({
  page,
}, testInfo) => {
  await installZaloBridge(page, testInfo.project.name);
  await page.goto(`${storefronts[0].url}#/profile`);
  await expect(page.locator('.status-card.success')).toBeVisible();

  const zaloButton = page.locator('.identity-actions button').nth(0);
  const manualButton = page.locator('.identity-actions button').nth(1);
  const [zaloInactiveBackground, manualInactiveBackground] = await Promise.all([
    zaloButton.evaluate((element) => getComputedStyle(element).backgroundColor),
    manualButton.evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);

  await expect(zaloButton).toHaveAttribute('aria-pressed', 'false');
  await expect(manualButton).toHaveAttribute('aria-pressed', 'false');
  expect(zaloInactiveBackground).toBe(manualInactiveBackground);
  await manualButton.click();
  await expect(manualButton).toHaveAttribute('aria-pressed', 'true');
  await expect(zaloButton).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.manual-form')).toBeVisible();
  const [zaloAfterSelection, manualAfterSelection] = await Promise.all([
    zaloButton.evaluate((element) => getComputedStyle(element).backgroundColor),
    manualButton.evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  expect(zaloAfterSelection).toBe(zaloInactiveBackground);
  expect(manualAfterSelection).not.toBe(manualInactiveBackground);
  expect(manualAfterSelection).not.toBe(zaloAfterSelection);

  await zaloButton.click();
  await expect(page.locator('.manual-form')).toBeVisible();
  await expect(page.locator('.feedback')).toBeVisible();
  await manualButton.click();
  await expect(page.locator('.manual-form')).toBeVisible();
  await expect(page.locator('.feedback')).toHaveCount(0);
  await expect(manualButton).toHaveAttribute('aria-pressed', 'true');
});
