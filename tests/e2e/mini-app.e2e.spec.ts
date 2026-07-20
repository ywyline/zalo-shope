import { expect, test, type Page } from '@playwright/test';

const storefronts = [
  {
    code: 'beauty-local',
    industry: 'beauty',
    names: { en: 'Beauty Store', vi: 'Cửa hàng Mỹ phẩm', zh: '美妆商城' },
    otherProduct: 'Sơ mi linen thoáng nhẹ',
    product: 'Tinh chất Sương Mai',
    productEn: 'Dew Renewal Serum',
    productZh: '晨露焕新精华',
    titles: { en: 'Glow, softly', vi: 'Rạng rỡ thật dịu dàng', zh: '温柔焕亮' },
    url: 'http://127.0.0.1:5174/',
  },
  {
    code: 'fashion-local',
    industry: 'fashion',
    names: { en: 'Fashion Store', vi: 'Cửa hàng Thời trang', zh: '服装商城' },
    otherProduct: 'Tinh chất Sương Mai',
    product: 'Sơ mi linen thoáng nhẹ',
    productEn: 'Air Linen Shirt',
    productZh: '轻盈亚麻衬衫',
    titles: { en: 'The new ease', vi: 'Thanh lịch thật tự nhiên', zh: '自在新廓形' },
    url: 'http://127.0.0.1:5175/',
  },
] as const;

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
