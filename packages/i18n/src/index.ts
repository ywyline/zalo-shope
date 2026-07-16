import type { Locale } from '@zalo-shop/domain';

const vi = {
  'app.loading': 'Đang tải cửa hàng…',
  'app.retry': 'Thử lại',
  'app.title': 'Nền tảng cửa hàng Zalo',
  'auth.phone.manual': 'Nhập số điện thoại thủ công',
  'auth.phone.permissionDenied': 'Bạn có thể tiếp tục bằng cách nhập số điện thoại.',
  'error.authorizationDenied': 'Bạn không có quyền thực hiện thao tác này.',
  'error.generic': 'Đã xảy ra lỗi. Vui lòng thử lại.',
  'language.en': 'Tiếng Anh',
  'language.vi': 'Tiếng Việt',
  'language.zh': 'Tiếng Trung',
  'store.empty': 'Không có cửa hàng khả dụng.',
} as const;

type MessageKey = keyof typeof vi;

const zh: Partial<Record<MessageKey, string>> = {
  'app.loading': '正在加载商城…',
  'app.retry': '重试',
  'app.title': 'Zalo 多商城底座',
  'auth.phone.manual': '手工输入手机号',
  'auth.phone.permissionDenied': '你可以通过手工输入手机号继续。',
  'error.authorizationDenied': '你无权执行此操作。',
  'error.generic': '发生错误，请重试。',
  'language.en': '英语',
  'language.vi': '越南语',
  'language.zh': '中文',
  'store.empty': '暂无可用商城。',
};

const en: Partial<Record<MessageKey, string>> = {
  'app.loading': 'Loading store…',
  'app.retry': 'Retry',
  'app.title': 'Zalo multi-store foundation',
  'auth.phone.manual': 'Enter phone number manually',
  'auth.phone.permissionDenied': 'You can continue by entering your phone number.',
  'error.authorizationDenied': 'You are not allowed to perform this action.',
  'error.generic': 'Something went wrong. Please try again.',
  'language.en': 'English',
  'language.vi': 'Vietnamese',
  'language.zh': 'Chinese',
  'store.empty': 'No stores are available.',
};

const resources: Record<Locale, Partial<Record<MessageKey, string>>> = { en, vi, zh };

export type { MessageKey };

export function translate(locale: Locale, key: MessageKey): string {
  return resources[locale][key] ?? vi[key];
}

export function formatVnd(amount: number, locale: Locale = 'vi'): string {
  if (!Number.isSafeInteger(amount)) {
    throw new TypeError('VND amount must be a safe integer');
  }
  const localeTag = locale === 'zh' ? 'zh-CN' : locale === 'en' ? 'en-US' : 'vi-VN';
  return new Intl.NumberFormat(localeTag, {
    currency: 'VND',
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
    style: 'currency',
  }).format(amount);
}

export function formatVietnamDate(value: Date | number | string, locale: Locale = 'vi'): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('Invalid date');
  }
  const localeTag = locale === 'zh' ? 'zh-CN' : locale === 'en' ? 'en-US' : 'vi-VN';
  return new Intl.DateTimeFormat(localeTag, {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
  }).format(date);
}

const VIETNAM_MOBILE_PATTERN = /^0(?:3[2-9]|5[25689]|7[06-9]|8[1-689]|9[0-46-9])\d{7}$/;

export function normalizeVietnamPhone(input: string): string {
  const compact = input.replace(/[\s().-]/g, '');
  const national = compact.startsWith('+84')
    ? `0${compact.slice(3)}`
    : compact.startsWith('84')
      ? `0${compact.slice(2)}`
      : compact;

  if (!VIETNAM_MOBILE_PATTERN.test(national)) {
    throw new TypeError('Invalid Vietnam mobile number');
  }
  return `+84${national.slice(1)}`;
}

export type VietnamAddress = Readonly<{
  country?: string;
  detail: string;
  district: string;
  province: string;
  ward: string;
}>;

export function formatVietnamAddress(address: VietnamAddress): string {
  const parts = [
    address.detail,
    address.ward,
    address.district,
    address.province,
    address.country ?? 'Việt Nam',
  ].map((part) => part.trim());

  if (parts.some((part) => part.length === 0)) {
    throw new TypeError('Vietnam address fields are required');
  }
  return parts.join(', ');
}
