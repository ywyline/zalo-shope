import type { Locale } from '@zalo-shop/domain';

const vi = {
  'app.loading': 'Đang tải cửa hàng…',
  'app.retry': 'Thử lại',
  'app.title': 'Nền tảng cửa hàng Zalo',
  'catalog.allProducts': 'Tất cả sản phẩm',
  'catalog.attributes': 'Thông tin sản phẩm',
  'catalog.back': 'Quay lại',
  'catalog.brands': 'Thương hiệu',
  'catalog.brands.intro': 'Những thương hiệu được tuyển chọn cho từng cửa hàng.',
  'catalog.browse': 'Khám phá theo danh mục và thương hiệu',
  'catalog.cart': 'Giỏ hàng',
  'catalog.categories': 'Danh mục',
  'catalog.categories.intro': 'Tìm nhanh sản phẩm phù hợp với nhu cầu của bạn.',
  'catalog.description': 'Chi tiết',
  'catalog.empty': 'Chưa có nội dung phù hợp.',
  'catalog.error': 'Không thể tải nội dung lúc này.',
  'catalog.explore': 'Khám phá',
  'catalog.filters': 'Bộ lọc đang áp dụng',
  'catalog.home': 'Trang chủ',
  'catalog.imageUnavailable': 'Hình ảnh đang được cập nhật',
  'catalog.language': 'Ngôn ngữ',
  'catalog.loadMore': 'Xem thêm',
  'catalog.loading': 'Đang chuẩn bị bộ sưu tập…',
  'catalog.m3Notice': 'Giỏ hàng và tồn kho trực tiếp sẽ mở ở M3.',
  'catalog.notAvailable': 'Chưa thể mua',
  'catalog.orders': 'Đơn hàng',
  'catalog.priceFrom': 'Từ',
  'catalog.product': 'Sản phẩm',
  'catalog.products': 'Bộ sưu tập',
  'catalog.profile': 'Của tôi',
  'catalog.retry': 'Tải lại',
  'catalog.selectedSku': 'Phiên bản đã chọn',
  'catalog.sort.newest': 'Mới nhất',
  'catalog.sort.priceAsc': 'Giá thấp đến cao',
  'catalog.sort.priceDesc': 'Giá cao đến thấp',
  'catalog.storefront': 'Không gian mua sắm riêng',
  'catalog.usage': 'Cách sử dụng / chăm sóc',
  'catalog.viewAll': 'Xem tất cả',
  'identity.consent':
    'Tôi đồng ý lưu số điện thoại theo Chính sách quyền riêng tư phiên bản phone-v1.',
  'identity.error': 'Không thể xác minh danh tính Zalo. Hãy mở Mini App trong Zalo và thử lại.',
  'identity.intro':
    'Danh tính được xác minh riêng cho từng cửa hàng. Số điện thoại chỉ được xin để liên hệ đơn hàng và giao hàng khi bạn chủ động chọn.',
  'identity.loading': 'Đang kết nối an toàn…',
  'identity.manual': 'Nhập số điện thoại',
  'identity.manualHint': 'Bạn có thể nhập số Việt Nam. Số được mã hóa và không hiển thị đầy đủ.',
  'identity.manualRequired': 'Vui lòng nhập số điện thoại và xác nhận đồng ý.',
  'identity.phone': 'Số điện thoại Việt Nam',
  'identity.phoneDenied': 'Bạn chưa cấp quyền số điện thoại. Hãy dùng cách nhập thủ công.',
  'identity.phoneError': 'Không thể lưu số điện thoại lúc này. Vui lòng thử lại.',
  'identity.phoneSaved': 'Đã lưu an toàn:',
  'identity.phoneTitle': 'Thêm số điện thoại',
  'identity.ready': 'Đã kết nối với Zalo',
  'identity.requestPhone': 'Dùng số từ Zalo',
  'identity.save': 'Lưu số điện thoại',
  'identity.saving': 'Đang lưu…',
  'identity.signedOut': 'Cần xác minh Zalo trước khi lưu số điện thoại.',
  'search.activeFilters': 'bộ lọc đang bật',
  'search.apply': 'Áp dụng bộ lọc',
  'search.attributes': 'Thuộc tính',
  'search.available': 'Còn hàng',
  'search.brand': 'Thương hiệu',
  'search.category': 'Danh mục',
  'search.clearHistory': 'Xóa lịch sử',
  'search.close': 'Đóng',
  'search.error': 'Không thể tải kết quả tìm kiếm.',
  'search.filters': 'Bộ lọc',
  'search.history': 'Tìm kiếm gần đây',
  'search.inStock': 'Chỉ còn hàng',
  'search.loadMore': 'Xem thêm kết quả',
  'search.loading': 'Đang tìm sản phẩm phù hợp…',
  'search.loginHistory': 'Kết nối Zalo để lưu lịch sử tìm kiếm riêng của bạn.',
  'search.maxPrice': 'Giá cao nhất',
  'search.minPrice': 'Giá thấp nhất',
  'search.noHistory': 'Chưa có tìm kiếm gần đây.',
  'search.noResults': 'Không tìm thấy sản phẩm phù hợp.',
  'search.onPromotion': 'Đang khuyến mãi',
  'search.outOfStock': 'Tạm hết hàng',
  'search.placeholder': 'Tìm sản phẩm, thương hiệu, danh mục…',
  'search.price': 'Khoảng giá (VND)',
  'search.recommendations': 'Có thể bạn sẽ thích',
  'search.reset': 'Đặt lại',
  'search.results': 'Kết quả tìm kiếm',
  'search.retry': 'Thử tìm lại',
  'search.sort.newest': 'Mới nhất',
  'search.sort.priceAsc': 'Giá thấp đến cao',
  'search.sort.priceDesc': 'Giá cao đến thấp',
  'search.sort.relevance': 'Phù hợp nhất',
  'search.submit': 'Tìm kiếm',
  'search.suggestions': 'Gợi ý',
  'search.title': 'Tìm kiếm',
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
  'catalog.allProducts': '全部商品',
  'catalog.attributes': '商品信息',
  'catalog.back': '返回',
  'catalog.brands': '品牌馆',
  'catalog.brands.intro': '为每个商城独立甄选的品牌。',
  'catalog.browse': '按类目和品牌探索',
  'catalog.cart': '购物车',
  'catalog.categories': '分类',
  'catalog.categories.intro': '快速找到适合你的商品。',
  'catalog.description': '详情',
  'catalog.empty': '暂无符合条件的内容。',
  'catalog.error': '暂时无法加载内容。',
  'catalog.explore': '去探索',
  'catalog.filters': '当前筛选',
  'catalog.home': '首页',
  'catalog.imageUnavailable': '图片更新中',
  'catalog.language': '语言',
  'catalog.loadMore': '加载更多',
  'catalog.loading': '正在准备精选内容…',
  'catalog.m3Notice': '购物车和实时库存将在 M3 开放。',
  'catalog.notAvailable': '暂不可购买',
  'catalog.orders': '订单',
  'catalog.priceFrom': '起',
  'catalog.product': '商品',
  'catalog.products': '商品精选',
  'catalog.profile': '我的',
  'catalog.retry': '重新加载',
  'catalog.selectedSku': '已选规格',
  'catalog.sort.newest': '最新上架',
  'catalog.sort.priceAsc': '价格从低到高',
  'catalog.sort.priceDesc': '价格从高到低',
  'catalog.storefront': '你的专属购物空间',
  'catalog.usage': '使用 / 护理说明',
  'catalog.viewAll': '查看全部',
  'identity.consent': '我同意按 phone-v1 隐私政策保存手机号。',
  'identity.error': '无法验证 Zalo 身份。请在 Zalo 内打开 Mini App 后重试。',
  'identity.intro': '身份按商城独立验证。只有你主动选择时，才会请求手机号用于订单联系和配送。',
  'identity.loading': '正在安全连接…',
  'identity.manual': '手工输入手机号',
  'identity.manualHint': '你可以输入越南手机号；号码会加密保存，不会完整显示。',
  'identity.manualRequired': '请输入手机号并确认同意。',
  'identity.phone': '越南手机号',
  'identity.phoneDenied': '你尚未授权手机号，可以使用手工输入。',
  'identity.phoneError': '当前无法保存手机号，请重试。',
  'identity.phoneSaved': '已安全保存：',
  'identity.phoneTitle': '添加手机号',
  'identity.ready': '已连接 Zalo',
  'identity.requestPhone': '使用 Zalo 手机号',
  'identity.save': '保存手机号',
  'identity.saving': '正在保存…',
  'identity.signedOut': '保存手机号前需要先完成 Zalo 身份验证。',
  'search.activeFilters': '个筛选条件',
  'search.apply': '应用筛选',
  'search.attributes': '商品属性',
  'search.available': '有货',
  'search.brand': '品牌',
  'search.category': '分类',
  'search.clearHistory': '清空历史',
  'search.close': '关闭',
  'search.error': '暂时无法加载搜索结果。',
  'search.filters': '筛选',
  'search.history': '最近搜索',
  'search.inStock': '仅看有货',
  'search.loadMore': '加载更多结果',
  'search.loading': '正在查找合适的商品…',
  'search.loginHistory': '连接 Zalo 后可保存仅属于你的搜索历史。',
  'search.maxPrice': '最高价格',
  'search.minPrice': '最低价格',
  'search.noHistory': '暂无最近搜索。',
  'search.noResults': '没有找到符合条件的商品。',
  'search.onPromotion': '促销商品',
  'search.outOfStock': '暂时缺货',
  'search.placeholder': '搜索商品、品牌、分类…',
  'search.price': '价格区间（VND）',
  'search.recommendations': '为你推荐',
  'search.reset': '重置',
  'search.results': '搜索结果',
  'search.retry': '重新搜索',
  'search.sort.newest': '最新上架',
  'search.sort.priceAsc': '价格从低到高',
  'search.sort.priceDesc': '价格从高到低',
  'search.sort.relevance': '综合推荐',
  'search.submit': '搜索',
  'search.suggestions': '搜索建议',
  'search.title': '搜索',
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
  'catalog.allProducts': 'All products',
  'catalog.attributes': 'Product information',
  'catalog.back': 'Back',
  'catalog.brands': 'Brands',
  'catalog.brands.intro': 'Brands curated independently for each storefront.',
  'catalog.browse': 'Explore by category and brand',
  'catalog.cart': 'Cart',
  'catalog.categories': 'Categories',
  'catalog.categories.intro': 'Find the right products for you quickly.',
  'catalog.description': 'Details',
  'catalog.empty': 'No matching content yet.',
  'catalog.error': 'Content could not be loaded right now.',
  'catalog.explore': 'Explore',
  'catalog.filters': 'Active filters',
  'catalog.home': 'Home',
  'catalog.imageUnavailable': 'Image being updated',
  'catalog.language': 'Language',
  'catalog.loadMore': 'Load more',
  'catalog.loading': 'Preparing the collection…',
  'catalog.m3Notice': 'Cart and live inventory arrive in M3.',
  'catalog.notAvailable': 'Not available yet',
  'catalog.orders': 'Orders',
  'catalog.priceFrom': 'From',
  'catalog.product': 'Product',
  'catalog.products': 'Collection',
  'catalog.profile': 'Profile',
  'catalog.retry': 'Reload',
  'catalog.selectedSku': 'Selected option',
  'catalog.sort.newest': 'Newest',
  'catalog.sort.priceAsc': 'Price: low to high',
  'catalog.sort.priceDesc': 'Price: high to low',
  'catalog.storefront': 'Your private shopping space',
  'catalog.usage': 'Use / care instructions',
  'catalog.viewAll': 'View all',
  'identity.consent': 'I agree to save my phone number under privacy policy phone-v1.',
  'identity.error': 'Zalo identity could not be verified. Open this Mini App in Zalo and retry.',
  'identity.intro':
    'Identity is verified per store. Your phone is requested for order contact and delivery only when you choose to share it.',
  'identity.loading': 'Connecting securely…',
  'identity.manual': 'Enter phone manually',
  'identity.manualHint': 'Enter a Vietnamese number. It is encrypted and never shown in full.',
  'identity.manualRequired': 'Enter a phone number and confirm consent.',
  'identity.phone': 'Vietnamese phone number',
  'identity.phoneDenied': 'Phone access was not granted. Use manual entry instead.',
  'identity.phoneError': 'The phone number could not be saved. Please retry.',
  'identity.phoneSaved': 'Saved securely:',
  'identity.phoneTitle': 'Add a phone number',
  'identity.ready': 'Connected to Zalo',
  'identity.requestPhone': 'Use Zalo phone number',
  'identity.save': 'Save phone number',
  'identity.saving': 'Saving…',
  'identity.signedOut': 'Verify your Zalo identity before saving a phone number.',
  'search.activeFilters': 'active filters',
  'search.apply': 'Apply filters',
  'search.attributes': 'Attributes',
  'search.available': 'In stock',
  'search.brand': 'Brand',
  'search.category': 'Category',
  'search.clearHistory': 'Clear history',
  'search.close': 'Close',
  'search.error': 'Search results could not be loaded.',
  'search.filters': 'Filters',
  'search.history': 'Recent searches',
  'search.inStock': 'In-stock only',
  'search.loadMore': 'Load more results',
  'search.loading': 'Finding the right products…',
  'search.loginHistory': 'Connect with Zalo to keep your private search history.',
  'search.maxPrice': 'Maximum price',
  'search.minPrice': 'Minimum price',
  'search.noHistory': 'No recent searches yet.',
  'search.noResults': 'No products match your search.',
  'search.onPromotion': 'On promotion',
  'search.outOfStock': 'Out of stock',
  'search.placeholder': 'Search products, brands, categories…',
  'search.price': 'Price range (VND)',
  'search.recommendations': 'You may also like',
  'search.reset': 'Reset',
  'search.results': 'Search results',
  'search.retry': 'Search again',
  'search.sort.newest': 'Newest',
  'search.sort.priceAsc': 'Price: low to high',
  'search.sort.priceDesc': 'Price: high to low',
  'search.sort.relevance': 'Most relevant',
  'search.submit': 'Search',
  'search.suggestions': 'Suggestions',
  'search.title': 'Search',
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
