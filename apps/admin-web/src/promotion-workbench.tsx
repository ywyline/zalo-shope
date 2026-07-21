import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

type Locale = 'en' | 'vi' | 'zh';
type Store = { code: string; default_locale: Locale; id: string };
type Request = <T>(path: string, options?: RequestInit) => Promise<T>;
type Page<T> = { items: T[]; next_cursor: string | null };
type PromotionStatus = 'ACTIVE' | 'DRAFT' | 'ENDED' | 'PAUSED';
type CouponStatus = PromotionStatus;
type PricingBucket = 'COUPON' | 'ITEM' | 'ORDER' | 'SHIPPING';
type BenefitMethod = 'FIXED_VND' | 'FREE_SHIPPING_QUALIFICATION' | 'PERCENTAGE_BPS';
type Localization = { description: string | null; locale: Locale; name: string };
type PromotionTarget = {
  target_id: string | null;
  target_type: 'BRAND' | 'CATEGORY' | 'PRODUCT' | 'SKU' | 'STORE';
};
type TargetLookupType = Exclude<PromotionTarget['target_type'], 'STORE'>;
type TargetLookupItem = {
  code: string;
  id: string;
  names: Record<Locale, string | null>;
};
type TargetLookupPage = { items: TargetLookupItem[]; next_cursor: string | null };
type PromotionBenefit =
  | { method: 'FIXED_VND'; value: number }
  | { maximum_discount_vnd: number | null; method: 'PERCENTAGE_BPS'; value: number }
  | { method: 'FREE_SHIPPING_QUALIFICATION' };
type PromotionVersion = {
  benefit: PromotionBenefit;
  bucket: PricingBucket;
  created_at: string;
  ends_at: string | null;
  id: string;
  localizations: Localization[];
  minimum_quantity: number | null;
  minimum_spend_vnd: number | null;
  priority: number;
  published_at: string | null;
  stackable_with: PricingBucket[];
  starts_at: string;
  status: 'DRAFT' | 'PUBLISHED';
  targets: PromotionTarget[];
  version_number: number;
};
type Promotion = {
  active_version: PromotionVersion | null;
  code: string;
  created_at: string;
  id: string;
  status: PromotionStatus;
  updated_at: string;
  version: number;
};
type Coupon = {
  claimed_count: number;
  code: string;
  created_at: string;
  id: string;
  new_customer_only: boolean;
  per_member_claim_limit: 1;
  promotion_version_id: string;
  status: CouponStatus;
  total_claim_limit: number | null;
  updated_at: string;
  version: number;
};
type PriceRule = {
  basis_vnd?: number;
  bucket: PricingBucket;
  code: string;
  discount_vnd?: number;
  reason?: string;
  version_id: string;
};
type PricingQuote = {
  applied_rules: PriceRule[];
  base_subtotal_vnd: number;
  currency: 'VND';
  discount_vnd: number;
  lines: Array<{
    applied_rules?: PriceRule[];
    base_subtotal_vnd: number;
    base_unit_price_vnd: number;
    discount_vnd: number;
    issues: string[];
    payable_vnd: number;
    quantity: number;
    rejected_rules?: PriceRule[];
    sku_code: string;
  }>;
  merchandise_payable_vnd: number;
  order_payable_vnd: null;
  quote_hash: string;
  quoted_at: string;
  rejected_rules: PriceRule[];
  shipping_qualification: {
    candidates: Array<{ code: string; version_id: string }>;
    status: 'ELIGIBLE_PENDING_FREIGHT' | 'NOT_ELIGIBLE' | 'NOT_REQUESTED';
  };
};
type Section = 'coupons' | 'promotions' | 'quote';
type RuleEditor = { promotion?: Promotion; seed?: PromotionVersion };
type CouponEditor = { coupon?: Coupon };
type QuoteItem = { id: string; quantity: number; sku_code: string };
type Confirmation =
  | {
      idempotencyKey: string;
      kind: 'coupon';
      record: Coupon;
      verb: 'ACTIVATE' | 'END' | 'PAUSE';
    }
  | {
      idempotencyKey: string;
      kind: 'promotion';
      record: Promotion;
      verb: 'END' | 'PAUSE' | 'PUBLISH';
      versionId?: string;
    };

const buckets: PricingBucket[] = ['ITEM', 'ORDER', 'COUPON', 'SHIPPING'];
const stateConflictCodes = new Set([
  'COUPON_STATE_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'PROMOTION_STATE_CONFLICT',
  'PROMOTION_VERSION_STATE_CONFLICT',
  'VERSION_CONFLICT',
]);
const targetTypes: PromotionTarget['target_type'][] = [
  'STORE',
  'BRAND',
  'CATEGORY',
  'PRODUCT',
  'SKU',
];

const copy = {
  vi: {
    activate: 'Kích hoạt',
    active: 'Đang chạy',
    addItem: 'Thêm SKU',
    addTarget: 'Thêm phạm vi',
    allStore: 'Toàn bộ cửa hàng',
    appliedRules: 'Quy tắc đã áp dụng',
    baseAmount: 'Tạm tính gốc',
    benefit: 'Loại ưu đãi',
    benefitValue: 'Giá trị ưu đãi',
    bucket: 'Nhóm áp dụng',
    cancel: 'Hủy',
    claimed: 'Đã nhận',
    code: 'Mã',
    conflict: 'Dữ liệu vừa thay đổi. Đã tải lại phiên bản mới nhất, hãy thử lại.',
    confirm: 'Xác nhận thao tác',
    confirmHint: 'Nhập đúng mã xác nhận để tiếp tục thao tác có ghi nhật ký.',
    coupon: 'Mã giảm giá',
    couponRule: 'Phiên bản quy tắc COUPON',
    coupons: 'Phiếu giảm giá',
    create: 'Tạo',
    createCoupon: 'Phiếu mới',
    createPromotion: 'Khuyến mãi mới',
    descriptionEn: 'Mô tả tiếng Anh',
    descriptionVi: 'Mô tả tiếng Việt',
    descriptionZh: 'Mô tả tiếng Trung',
    discount: 'Giảm giá',
    draft: 'Bản nháp',
    edit: 'Sửa quy tắc',
    emptyCoupons: 'Chưa có phiếu giảm giá trong cửa hàng này.',
    emptyPromotions: 'Chưa có khuyến mãi trong cửa hàng này.',
    end: 'Kết thúc',
    ended: 'Đã kết thúc',
    endTime: 'Kết thúc',
    error: 'Không thể tải hoặc lưu dữ liệu khuyến mãi.',
    fixed: 'Giảm số tiền cố định',
    freeShipping: 'Điều kiện miễn phí vận chuyển',
    limit: 'Giới hạn lượt nhận',
    loading: 'Đang tải dữ liệu khuyến mãi…',
    maxDiscount: 'Mức giảm tối đa',
    merchandisePayable: 'Tiền hàng sau ưu đãi',
    minimumQuantity: 'Số lượng tối thiểu',
    minimumSpend: 'Chi tiêu tối thiểu',
    nameEn: 'Tên tiếng Anh',
    nameVi: 'Tên tiếng Việt',
    nameZh: 'Tên tiếng Trung',
    newCustomer: 'Chỉ dành cho khách hàng mới',
    noCouponRule: 'Cần xuất bản một quy tắc thuộc nhóm COUPON trước.',
    noDraft: 'Khuyến mãi chưa có phiên bản nháp để xuất bản.',
    orderPending: 'Tổng đơn hàng chờ M4 tính lại vận chuyển.',
    pause: 'Tạm dừng',
    paused: 'Tạm dừng',
    percent: 'Giảm theo tỷ lệ (bps)',
    preview: 'Xem trước báo giá',
    priority: 'Ưu tiên',
    promotion: 'Khuyến mãi & định giá',
    promotions: 'Quy tắc khuyến mãi',
    publish: 'Xuất bản',
    publishedVersion: 'Phiên bản đang áp dụng',
    quantity: 'Số lượng',
    quote: 'Báo giá thật',
    quoteEmpty: 'Nhập SKU để lấy báo giá từ máy chủ.',
    quoteHash: 'Dấu vân tay báo giá',
    rejectedRules: 'Quy tắc không áp dụng',
    remove: 'Xóa',
    retry: 'Tải lại',
    save: 'Lưu bản nháp',
    scope: 'Phạm vi áp dụng',
    stacking: 'Cho phép kết hợp với',
    startTime: 'Bắt đầu',
    status: 'Trạng thái',
    success: 'Thao tác khuyến mãi đã hoàn tất.',
    targetStore: 'Phạm vi STORE',
    targetId: 'UUID đối tượng',
    targetSearch: 'Tìm theo mã hoặc tên',
    targetSelect: 'Chọn đối tượng',
    targetLookupEmpty: 'Không tìm thấy đối tượng phù hợp.',
    targetType: 'Loại phạm vi',
    timeWindow: 'Khung thời gian',
    unlimited: 'Không giới hạn',
    version: 'Phiên bản',
  },
  zh: {
    activate: '启用',
    active: '进行中',
    addItem: '添加 SKU',
    addTarget: '添加适用范围',
    allStore: '全商城',
    appliedRules: '已应用规则',
    baseAmount: '商品原始小计',
    benefit: '优惠方式',
    benefitValue: '优惠数值',
    bucket: '计价槽位',
    cancel: '取消',
    claimed: '已领取',
    code: '编码',
    conflict: '数据刚刚发生变化，已加载最新版本，请重试。',
    confirm: '确认高风险操作',
    confirmHint: '输入准确确认码以继续这次受审操作。',
    coupon: '优惠券编码',
    couponRule: 'COUPON 规则版本',
    coupons: '优惠券',
    create: '创建',
    createCoupon: '新建优惠券',
    createPromotion: '新建促销',
    descriptionEn: '英文说明',
    descriptionVi: '越南语说明',
    descriptionZh: '中文说明',
    discount: '优惠金额',
    draft: '草稿',
    edit: '编辑规则',
    emptyCoupons: '当前商城暂无优惠券。',
    emptyPromotions: '当前商城暂无促销规则。',
    end: '结束',
    ended: '已结束',
    endTime: '结束时间',
    error: '促销数据加载或保存失败。',
    fixed: '固定金额优惠',
    freeShipping: '包邮资格',
    limit: '总领取上限',
    loading: '正在加载促销事实…',
    maxDiscount: '最高优惠金额',
    merchandisePayable: '商品应付',
    minimumQuantity: '最低数量',
    minimumSpend: '最低消费金额',
    nameEn: '英文名称',
    nameVi: '越南语名称',
    nameZh: '中文名称',
    newCustomer: '仅限新客',
    noCouponRule: '请先发布一个 COUPON 槽位的促销版本。',
    noDraft: '当前促销没有可发布的草稿版本。',
    orderPending: '最终订单应付等待 M4 加入真实运费后重算。',
    pause: '暂停',
    paused: '已暂停',
    percent: '比例优惠（基点）',
    preview: '获取服务端报价',
    priority: '优先级',
    promotion: '促销与价格',
    promotions: '促销规则',
    publish: '发布',
    publishedVersion: '当前发布版本',
    quantity: '数量',
    quote: '真实报价预览',
    quoteEmpty: '输入 SKU 后从服务端获取报价。',
    quoteHash: '报价指纹',
    rejectedRules: '未应用规则',
    remove: '移除',
    retry: '重新加载',
    save: '保存草稿',
    scope: '适用范围',
    stacking: '允许跨槽叠加',
    startTime: '开始时间',
    status: '状态',
    success: '促销操作已安全完成。',
    targetStore: 'STORE 全商城范围',
    targetId: '对象 UUID',
    targetSearch: '按编码或名称搜索',
    targetSelect: '选择对象',
    targetLookupEmpty: '没有匹配的对象。',
    targetType: '范围类型',
    timeWindow: '生效时间',
    unlimited: '不限量',
    version: '版本',
  },
  en: {
    activate: 'Activate',
    active: 'Active',
    addItem: 'Add SKU',
    addTarget: 'Add target',
    allStore: 'Entire store',
    appliedRules: 'Applied rules',
    baseAmount: 'Base subtotal',
    benefit: 'Benefit method',
    benefitValue: 'Benefit value',
    bucket: 'Pricing bucket',
    cancel: 'Cancel',
    claimed: 'Claimed',
    code: 'Code',
    conflict: 'The data changed. The latest version was loaded; please retry.',
    confirm: 'Confirm high-risk action',
    confirmHint: 'Enter the exact confirmation code to continue this audited action.',
    coupon: 'Coupon code',
    couponRule: 'COUPON rule version',
    coupons: 'Coupons',
    create: 'Create',
    createCoupon: 'New coupon',
    createPromotion: 'New promotion',
    descriptionEn: 'English description',
    descriptionVi: 'Vietnamese description',
    descriptionZh: 'Chinese description',
    discount: 'Discount',
    draft: 'Draft',
    edit: 'Edit rule',
    emptyCoupons: 'No coupons exist in this store.',
    emptyPromotions: 'No promotion rules exist in this store.',
    end: 'End',
    ended: 'Ended',
    endTime: 'Ends at',
    error: 'Promotion data could not be loaded or saved.',
    fixed: 'Fixed VND discount',
    freeShipping: 'Free-shipping qualification',
    limit: 'Total claim limit',
    loading: 'Loading promotion facts…',
    maxDiscount: 'Maximum discount',
    merchandisePayable: 'Merchandise payable',
    minimumQuantity: 'Minimum quantity',
    minimumSpend: 'Minimum spend',
    nameEn: 'English name',
    nameVi: 'Vietnamese name',
    nameZh: 'Chinese name',
    newCustomer: 'New customers only',
    noCouponRule: 'Publish a COUPON bucket rule before creating a coupon.',
    noDraft: 'This promotion has no draft version to publish.',
    orderPending: 'Final order payable waits for M4 freight recalculation.',
    pause: 'Pause',
    paused: 'Paused',
    percent: 'Percentage discount (bps)',
    preview: 'Get server quote',
    priority: 'Priority',
    promotion: 'Promotions & pricing',
    promotions: 'Promotion rules',
    publish: 'Publish',
    publishedVersion: 'Active version',
    quantity: 'Quantity',
    quote: 'Live quote preview',
    quoteEmpty: 'Enter a SKU to request a server-side quote.',
    quoteHash: 'Quote fingerprint',
    rejectedRules: 'Rejected rules',
    remove: 'Remove',
    retry: 'Reload',
    save: 'Save draft',
    scope: 'Target scope',
    stacking: 'Allow stacking with',
    startTime: 'Starts at',
    status: 'Status',
    success: 'Promotion operation completed safely.',
    targetStore: 'STORE-wide target',
    targetId: 'Target UUID',
    targetSearch: 'Search by code or name',
    targetSelect: 'Select a target',
    targetLookupEmpty: 'No matching targets found.',
    targetType: 'Target type',
    timeWindow: 'Time window',
    unlimited: 'Unlimited',
    version: 'Version',
  },
} as const;

function jsonHeaders(headers: () => Record<string, string>): Record<string, string> {
  return { ...headers(), 'Content-Type': 'application/json' };
}

function formText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

function nullableInteger(value: FormDataEntryValue | null): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return Number(value);
}

function toInputDate(value?: string | null): string {
  const date = value ? new Date(value) : new Date(Date.now() + 60 * 60 * 1000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatDate(value: string | null, locale: Locale): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : locale === 'en' ? 'en-US' : 'vi-VN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatVnd(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : locale === 'en' ? 'en-US' : 'vi-VN', {
    currency: 'VND',
    maximumFractionDigits: 0,
    style: 'currency',
  }).format(value);
}

function localizedRuleName(
  version: PromotionVersion | null,
  locale: Locale,
  fallback: string,
): string {
  if (!version) return fallback;
  return (
    version.localizations.find((item) => item.locale === locale)?.name ??
    version.localizations.find((item) => item.locale === 'vi')?.name ??
    fallback
  );
}

function localizedTargetName(item: TargetLookupItem, locale: Locale): string {
  return item.names[locale] ?? item.names.vi ?? item.names.en ?? item.code;
}

function targetOptionLabel(item: TargetLookupItem, locale: Locale): string {
  return `${localizedTargetName(item, locale)} · ${item.code} · ${item.id}`;
}

function statusCopy(status: PromotionStatus, t: (typeof copy)[Locale]): string {
  if (status === 'ACTIVE') return t.active;
  if (status === 'PAUSED') return t.paused;
  if (status === 'ENDED') return t.ended;
  return t.draft;
}

function defaultQuoteItem(): QuoteItem {
  return { id: crypto.randomUUID(), quantity: 1, sku_code: '' };
}

export function PromotionWorkbench({
  headers,
  locale,
  request,
  store,
}: {
  headers: () => Record<string, string>;
  locale: Locale;
  request: Request;
  store: Store;
}): JSX.Element {
  const t = copy[locale];
  const query = `store_id=${encodeURIComponent(store.id)}`;
  const [section, setSection] = useState<Section>('promotions');
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [ruleEditor, setRuleEditor] = useState<RuleEditor>();
  const [ruleBucket, setRuleBucket] = useState<PricingBucket>('ITEM');
  const [benefitMethod, setBenefitMethod] = useState<BenefitMethod>('FIXED_VND');
  const [stackableWith, setStackableWith] = useState<PricingBucket[]>([]);
  const [ruleTargets, setRuleTargets] = useState<PromotionTarget[]>([
    { target_id: null, target_type: 'STORE' },
  ]);
  const [targetLookupOptions, setTargetLookupOptions] = useState<
    Record<number, TargetLookupItem[]>
  >({});
  const [targetLookupSearch, setTargetLookupSearch] = useState<Record<number, string>>({});
  const [targetLookupLoading, setTargetLookupLoading] = useState<Record<number, boolean>>({});
  const targetLookupSequence = useRef<Record<number, number>>({});
  const [couponEditor, setCouponEditor] = useState<CouponEditor>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [confirmationValue, setConfirmationValue] = useState('');
  const [quoteItems, setQuoteItems] = useState<QuoteItem[]>([defaultQuoteItem()]);
  const [quoteCoupon, setQuoteCoupon] = useState('');
  const [quote, setQuote] = useState<PricingQuote>();
  const [quoteLoading, setQuoteLoading] = useState(false);

  const loadAll = async <T,>(path: string): Promise<T[]> => {
    const items: T[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const page = await request<Page<T>>(
        `${path}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        { headers: headers() },
      );
      items.push(...page.items);
      if (!page.next_cursor) return items;
      cursor = page.next_cursor;
    }
    throw new Error('PAGE_LIMIT_EXCEEDED');
  };

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const [promotionItems, couponItems] = await Promise.all([
        loadAll<Promotion>(`/v1/admin/promotions?${query}`),
        loadAll<Coupon>(`/v1/admin/coupons?${query}`),
      ]);
      setPromotions(promotionItems);
      setCoupons(couponItems);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'INTERNAL_ERROR');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [store.id]);

  const activeCount = promotions.filter((item) => item.status === 'ACTIVE').length;
  const draftCount = promotions.filter((item) => item.status === 'DRAFT').length;
  const activeCouponCount = coupons.filter((item) => item.status === 'ACTIVE').length;
  const couponVersions = useMemo(
    () =>
      promotions.flatMap((promotion) =>
        promotion.status === 'ACTIVE' &&
        promotion.active_version?.bucket === 'COUPON' &&
        promotion.active_version.status === 'PUBLISHED'
          ? [
              {
                id: promotion.active_version.id,
                label: `${promotion.code} · v${promotion.active_version.version_number}`,
              },
            ]
          : [],
      ),
    [promotions],
  );

  const loadVersions = async (promotion: Promotion): Promise<PromotionVersion[]> => {
    return loadAll<PromotionVersion>(`/v1/admin/promotions/${promotion.id}/versions?${query}`);
  };

  const loadTargetOptions = async (
    index: number,
    targetType: TargetLookupType,
    search = '',
  ): Promise<void> => {
    const sequence = (targetLookupSequence.current[index] ?? 0) + 1;
    targetLookupSequence.current[index] = sequence;
    setTargetLookupLoading((current) => ({ ...current, [index]: true }));
    try {
      const params = new URLSearchParams({
        limit: '100',
        target_type: targetType,
        store_id: store.id,
      });
      if (search.trim()) params.set('q', search.trim());
      const page = await request<TargetLookupPage>(
        `/v1/admin/promotions/targets?${params.toString()}`,
        { headers: headers() },
      );
      if (targetLookupSequence.current[index] === sequence) {
        setTargetLookupOptions((current) => ({ ...current, [index]: page.items }));
      }
    } catch (cause) {
      if (targetLookupSequence.current[index] === sequence) {
        setError(cause instanceof Error ? cause.message : 'INTERNAL_ERROR');
      }
    } finally {
      if (targetLookupSequence.current[index] === sequence) {
        setTargetLookupLoading((current) => ({ ...current, [index]: false }));
      }
    }
  };

  const openRuleEditor = async (promotion?: Promotion): Promise<void> => {
    setError(undefined);
    if (!promotion) {
      setRuleBucket('ITEM');
      setBenefitMethod('FIXED_VND');
      setStackableWith([]);
      setRuleTargets([{ target_id: null, target_type: 'STORE' }]);
      setTargetLookupOptions({});
      setTargetLookupSearch({});
      setTargetLookupLoading({});
      targetLookupSequence.current = {};
      setRuleEditor({});
      return;
    }
    setBusy(true);
    try {
      const versions = await loadVersions(promotion);
      const seed =
        [...versions]
          .filter((version) => version.status === 'DRAFT')
          .sort((left, right) => right.version_number - left.version_number)[0] ??
        promotion.active_version ??
        undefined;
      setRuleBucket(seed?.bucket ?? 'ITEM');
      setBenefitMethod(seed?.benefit.method ?? 'FIXED_VND');
      setStackableWith(seed?.stackable_with ?? []);
      const targets = seed?.targets ?? [{ target_id: null, target_type: 'STORE' as const }];
      setRuleTargets(targets);
      setTargetLookupOptions({});
      setTargetLookupSearch({});
      setTargetLookupLoading({});
      targetLookupSequence.current = {};
      setRuleEditor({ promotion, seed });
      await Promise.all(
        targets.flatMap((target, index) =>
          target.target_type === 'STORE' ? [] : [loadTargetOptions(index, target.target_type, '')],
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'INTERNAL_ERROR');
    } finally {
      setBusy(false);
    }
  };

  const submitRule = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!ruleEditor) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      let promotion = ruleEditor.promotion;
      if (!promotion) {
        promotion = await request<Promotion>(`/v1/admin/promotions?${query}`, {
          body: JSON.stringify({ code: formText(form, 'code').trim().toLowerCase() }),
          headers: jsonHeaders(headers),
          method: 'POST',
        });
        setRuleEditor({ promotion });
      }
      const benefit: PromotionBenefit =
        benefitMethod === 'FREE_SHIPPING_QUALIFICATION'
          ? { method: benefitMethod }
          : benefitMethod === 'PERCENTAGE_BPS'
            ? {
                maximum_discount_vnd: nullableInteger(form.get('maximum_discount_vnd')),
                method: benefitMethod,
                value: Number(form.get('benefit_value')),
              }
            : { method: benefitMethod, value: Number(form.get('benefit_value')) };
      const localizations = (['vi', 'zh', 'en'] as const).flatMap((language) => {
        const name = formText(form, `name_${language}`).trim();
        if (!name) return [];
        return [
          {
            description: formText(form, `description_${language}`).trim() || null,
            locale: language,
            name,
          },
        ];
      });
      await request<PromotionVersion>(`/v1/admin/promotions/${promotion.id}/versions?${query}`, {
        body: JSON.stringify({
          benefit,
          bucket: ruleBucket,
          ends_at: formText(form, 'ends_at')
            ? new Date(formText(form, 'ends_at')).toISOString()
            : null,
          expected_promotion_version: promotion.version,
          localizations,
          minimum_quantity: nullableInteger(form.get('minimum_quantity')),
          minimum_spend_vnd: nullableInteger(form.get('minimum_spend_vnd')),
          priority: Number(form.get('priority')),
          stackable_with: stackableWith,
          starts_at: new Date(formText(form, 'starts_at')).toISOString(),
          targets: ruleTargets.map((target) => ({
            target_id: target.target_type === 'STORE' ? null : target.target_id?.trim(),
            target_type: target.target_type,
          })),
        }),
        headers: jsonHeaders(headers),
        method: 'POST',
      });
      setRuleEditor(undefined);
      setNotice(t.success);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'INTERNAL_ERROR');
    } finally {
      setBusy(false);
    }
  };

  const submitCoupon = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!couponEditor) return;
    const form = new FormData(event.currentTarget);
    const totalClaimLimit = nullableInteger(form.get('total_claim_limit'));
    setBusy(true);
    setError(undefined);
    try {
      if (couponEditor.coupon) {
        await request(`/v1/admin/coupons/${couponEditor.coupon.id}?${query}`, {
          body: JSON.stringify({
            expected_version: couponEditor.coupon.version,
            new_customer_only: form.get('new_customer_only') === 'on',
            per_member_claim_limit: 1,
            promotion_version_id: formText(form, 'promotion_version_id'),
            total_claim_limit: totalClaimLimit,
          }),
          headers: jsonHeaders(headers),
          method: 'PATCH',
        });
      } else {
        await request(`/v1/admin/coupons?${query}`, {
          body: JSON.stringify({
            code: formText(form, 'code').trim().toLowerCase(),
            new_customer_only: form.get('new_customer_only') === 'on',
            per_member_claim_limit: 1,
            promotion_version_id: formText(form, 'promotion_version_id'),
            total_claim_limit: totalClaimLimit,
          }),
          headers: jsonHeaders(headers),
          method: 'POST',
        });
      }
      setCouponEditor(undefined);
      setNotice(t.success);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'INTERNAL_ERROR');
    } finally {
      setBusy(false);
    }
  };

  const preparePromotionAction = async (
    promotion: Promotion,
    verb: 'END' | 'PAUSE' | 'PUBLISH',
  ): Promise<void> => {
    setError(undefined);
    let versionId: string | undefined;
    if (verb === 'PUBLISH') {
      setBusy(true);
      try {
        const versions = await loadVersions(promotion);
        versionId =
          [...versions]
            .filter((version) => version.status === 'DRAFT')
            .sort((left, right) => right.version_number - left.version_number)[0]?.id ??
          (promotion.status === 'PAUSED' ? promotion.active_version?.id : undefined);
        if (!versionId) {
          setError('PROMOTION_DRAFT_REQUIRED');
          return;
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'INTERNAL_ERROR');
        return;
      } finally {
        setBusy(false);
      }
    }
    setConfirmation({
      idempotencyKey: crypto.randomUUID(),
      kind: 'promotion',
      record: promotion,
      verb,
      versionId,
    });
    setConfirmationValue('');
  };

  const confirmAction = async (): Promise<void> => {
    if (!confirmation || confirmationValue !== confirmation.verb) return;
    setBusy(true);
    setError(undefined);
    try {
      if (confirmation.kind === 'promotion') {
        const path = confirmation.verb.toLowerCase();
        await request(`/v1/admin/promotions/${confirmation.record.id}/${path}?${query}`, {
          body: JSON.stringify(
            confirmation.verb === 'PUBLISH'
              ? {
                  confirmation_code: 'PUBLISH',
                  expected_promotion_version: confirmation.record.version,
                  version_id: confirmation.versionId,
                }
              : {
                  confirmation_code: confirmation.verb,
                  expected_promotion_version: confirmation.record.version,
                },
          ),
          headers: {
            ...jsonHeaders(headers),
            'Idempotency-Key': confirmation.idempotencyKey,
          },
          method: 'POST',
        });
      } else {
        const status =
          confirmation.verb === 'ACTIVATE'
            ? 'ACTIVE'
            : confirmation.verb === 'PAUSE'
              ? 'PAUSED'
              : 'ENDED';
        await request(`/v1/admin/coupons/${confirmation.record.id}/status?${query}`, {
          body: JSON.stringify({
            confirmation_code: confirmation.verb,
            expected_version: confirmation.record.version,
            status,
          }),
          headers: {
            ...jsonHeaders(headers),
            'Idempotency-Key': confirmation.idempotencyKey,
          },
          method: 'POST',
        });
      }
      setConfirmation(undefined);
      setConfirmationValue('');
      setNotice(t.success);
      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'INTERNAL_ERROR';
      if (stateConflictCodes.has(message)) {
        setConfirmation(undefined);
        setConfirmationValue('');
        await load();
      }
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const previewQuote = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setQuoteLoading(true);
    setError(undefined);
    try {
      const result = await request<PricingQuote>('/v1/pricing/quotes', {
        body: JSON.stringify({
          coupon_code: quoteCoupon.trim().toLowerCase() || null,
          items: quoteItems.map(({ quantity, sku_code }) => ({
            quantity,
            sku_code: sku_code.trim().toLowerCase(),
          })),
          locale,
        }),
        headers: jsonHeaders(headers),
        method: 'POST',
      });
      setQuote(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'INTERNAL_ERROR');
    } finally {
      setQuoteLoading(false);
    }
  };

  const openCouponAction = (coupon: Coupon, verb: 'ACTIVATE' | 'END' | 'PAUSE'): void => {
    setConfirmation({
      idempotencyKey: crypto.randomUUID(),
      kind: 'coupon',
      record: coupon,
      verb,
    });
    setConfirmationValue('');
  };

  const couponRuleOptions =
    couponEditor?.coupon &&
    !couponVersions.some((version) => version.id === couponEditor.coupon?.promotion_version_id)
      ? [
          ...couponVersions,
          {
            id: couponEditor.coupon.promotion_version_id,
            label: couponEditor.coupon.promotion_version_id,
          },
        ]
      : couponVersions;

  if (loading && promotions.length === 0 && coupons.length === 0) {
    return (
      <section className="content-state">
        <p>{t.loading}</p>
      </section>
    );
  }

  if (error && promotions.length === 0 && coupons.length === 0) {
    return (
      <section className="content-state error-state">
        <strong>{t.error}</strong>
        <small>{error}</small>
        <button className="secondary" onClick={() => void load()}>
          {t.retry}
        </button>
      </section>
    );
  }

  return (
    <section className="promotion-workbench">
      <header className="promotion-heading">
        <div>
          <p className="eyebrow">M3.5 · {store.code}</p>
          <h2>{t.promotion}</h2>
        </div>
        <button className="secondary" disabled={loading || busy} onClick={() => void load()}>
          {loading ? t.loading : t.retry}
        </button>
      </header>

      <div className="promotion-metrics" aria-label={t.promotion}>
        <div>
          <span>{t.active}</span>
          <strong>{activeCount}</strong>
        </div>
        <div>
          <span>{t.draft}</span>
          <strong>{draftCount}</strong>
        </div>
        <div>
          <span>{t.coupons}</span>
          <strong>{activeCouponCount}</strong>
        </div>
        <div>
          <span>{t.publishedVersion}</span>
          <strong>{promotions.filter((item) => item.active_version).length}</strong>
        </div>
      </div>

      <nav className="promotion-tabs" aria-label={t.promotion}>
        {(
          [
            ['promotions', t.promotions],
            ['coupons', t.coupons],
            ['quote', t.quote],
          ] as const
        ).map(([value, label]) => (
          <button
            className={section === value ? 'active' : ''}
            key={value}
            onClick={() => setSection(value)}
          >
            {label}
          </button>
        ))}
      </nav>

      {error && (
        <div className="workbench-message error" role="alert">
          <span>
            {error === 'PROMOTION_DRAFT_REQUIRED'
              ? t.noDraft
              : stateConflictCodes.has(error)
                ? t.conflict
                : t.error}
          </span>
          <button onClick={() => setError(undefined)}>×</button>
        </div>
      )}
      {notice && (
        <div className="workbench-message success" role="status">
          <span>{notice}</span>
          <button onClick={() => setNotice(undefined)}>×</button>
        </div>
      )}

      {section === 'promotions' ? (
        <div className="promotion-panel">
          <div className="promotion-panel-title">
            <h3>{t.promotions}</h3>
            <button className="primary" disabled={busy} onClick={() => void openRuleEditor()}>
              {t.createPromotion}
            </button>
          </div>
          {promotions.length ? (
            <div className="promotion-table-wrap">
              <table className="promotion-table">
                <thead>
                  <tr>
                    <th>{t.code}</th>
                    <th>{t.status}</th>
                    <th>{t.bucket}</th>
                    <th>{t.timeWindow}</th>
                    <th aria-label={t.edit} />
                  </tr>
                </thead>
                <tbody>
                  {promotions.map((promotion) => (
                    <tr key={promotion.id}>
                      <td>
                        <strong>
                          {localizedRuleName(promotion.active_version, locale, promotion.code)}
                        </strong>
                        <small>{promotion.code}</small>
                      </td>
                      <td>
                        <span className={`promotion-status ${promotion.status.toLowerCase()}`}>
                          {statusCopy(promotion.status, t)}
                        </span>
                      </td>
                      <td>{promotion.active_version?.bucket ?? '—'}</td>
                      <td>
                        <span>
                          {formatDate(promotion.active_version?.starts_at ?? null, locale)}
                        </span>
                        <small>
                          {formatDate(promotion.active_version?.ends_at ?? null, locale)}
                        </small>
                      </td>
                      <td>
                        <div className="promotion-actions">
                          {promotion.status !== 'ENDED' && (
                            <button
                              className="text-button"
                              disabled={busy}
                              onClick={() => void openRuleEditor(promotion)}
                            >
                              {t.edit}
                            </button>
                          )}
                          {promotion.status !== 'ENDED' && (
                            <button
                              className="secondary compact"
                              disabled={busy}
                              onClick={() => void preparePromotionAction(promotion, 'PUBLISH')}
                            >
                              {t.publish}
                            </button>
                          )}
                          {promotion.status === 'ACTIVE' && (
                            <button
                              className="secondary compact"
                              disabled={busy}
                              onClick={() => void preparePromotionAction(promotion, 'PAUSE')}
                            >
                              {t.pause}
                            </button>
                          )}
                          {(promotion.status === 'ACTIVE' || promotion.status === 'PAUSED') && (
                            <button
                              className="danger-button compact"
                              disabled={busy}
                              onClick={() => void preparePromotionAction(promotion, 'END')}
                            >
                              {t.end}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="promotion-state">{t.emptyPromotions}</p>
          )}
        </div>
      ) : section === 'coupons' ? (
        <div className="promotion-panel">
          <div className="promotion-panel-title">
            <h3>{t.coupons}</h3>
            <button
              className="primary"
              disabled={busy || couponVersions.length === 0}
              onClick={() => setCouponEditor({})}
              title={couponVersions.length ? undefined : t.noCouponRule}
            >
              {t.createCoupon}
            </button>
          </div>
          {couponVersions.length === 0 && <p className="promotion-inline-note">{t.noCouponRule}</p>}
          {coupons.length ? (
            <div className="promotion-table-wrap">
              <table className="promotion-table coupon-table">
                <thead>
                  <tr>
                    <th>{t.code}</th>
                    <th>{t.status}</th>
                    <th>{t.claimed}</th>
                    <th>{t.limit}</th>
                    <th aria-label={t.edit} />
                  </tr>
                </thead>
                <tbody>
                  {coupons.map((coupon) => (
                    <tr key={coupon.id}>
                      <td>
                        <strong>{coupon.code}</strong>
                        <small>
                          {coupon.new_customer_only ? `${t.newCustomer} · ` : ''}
                          {coupon.promotion_version_id.slice(0, 8)}
                        </small>
                      </td>
                      <td>
                        <span className={`promotion-status ${coupon.status.toLowerCase()}`}>
                          {statusCopy(coupon.status, t)}
                        </span>
                      </td>
                      <td>{coupon.claimed_count}</td>
                      <td>{coupon.total_claim_limit ?? t.unlimited}</td>
                      <td>
                        <div className="promotion-actions">
                          {coupon.status === 'DRAFT' && (
                            <button
                              className="text-button"
                              disabled={busy}
                              onClick={() => setCouponEditor({ coupon })}
                            >
                              {t.edit}
                            </button>
                          )}
                          {(coupon.status === 'DRAFT' || coupon.status === 'PAUSED') && (
                            <button
                              className="secondary compact"
                              disabled={busy}
                              onClick={() => openCouponAction(coupon, 'ACTIVATE')}
                            >
                              {t.activate}
                            </button>
                          )}
                          {coupon.status === 'ACTIVE' && (
                            <button
                              className="secondary compact"
                              disabled={busy}
                              onClick={() => openCouponAction(coupon, 'PAUSE')}
                            >
                              {t.pause}
                            </button>
                          )}
                          {(coupon.status === 'ACTIVE' || coupon.status === 'PAUSED') && (
                            <button
                              className="danger-button compact"
                              disabled={busy}
                              onClick={() => openCouponAction(coupon, 'END')}
                            >
                              {t.end}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="promotion-state">{t.emptyCoupons}</p>
          )}
        </div>
      ) : (
        <div className="quote-workspace">
          <form className="quote-form" onSubmit={(event) => void previewQuote(event)}>
            <div className="promotion-panel-title">
              <h3>{t.quote}</h3>
              <button className="primary" disabled={quoteLoading || busy} type="submit">
                {quoteLoading ? t.loading : t.preview}
              </button>
            </div>
            <div className="quote-items">
              {quoteItems.map((item, index) => (
                <div className="quote-item" key={item.id}>
                  <label>
                    SKU
                    <input
                      onChange={(event) =>
                        setQuoteItems((current) =>
                          current.map((candidate) =>
                            candidate.id === item.id
                              ? { ...candidate, sku_code: event.target.value }
                              : candidate,
                          ),
                        )
                      }
                      pattern="[a-z][a-z0-9\-]{1,63}"
                      required
                      value={item.sku_code}
                    />
                  </label>
                  <label>
                    {t.quantity}
                    <input
                      max={99}
                      min={1}
                      onChange={(event) =>
                        setQuoteItems((current) =>
                          current.map((candidate) =>
                            candidate.id === item.id
                              ? { ...candidate, quantity: Number(event.target.value) }
                              : candidate,
                          ),
                        )
                      }
                      required
                      type="number"
                      value={item.quantity}
                    />
                  </label>
                  <button
                    aria-label={`${t.remove} ${index + 1}`}
                    className="icon-button"
                    disabled={quoteItems.length === 1}
                    onClick={() =>
                      setQuoteItems((current) =>
                        current.filter((candidate) => candidate.id !== item.id),
                      )
                    }
                    title={t.remove}
                    type="button"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="quote-form-footer">
              <button
                className="secondary"
                disabled={quoteItems.length >= 100}
                onClick={() => setQuoteItems((current) => [...current, defaultQuoteItem()])}
                type="button"
              >
                + {t.addItem}
              </button>
              <label>
                {t.coupon}
                <input
                  onChange={(event) => setQuoteCoupon(event.target.value)}
                  pattern="[a-z][a-z0-9\-]{1,63}"
                  value={quoteCoupon}
                />
              </label>
            </div>
          </form>

          {quote ? (
            <div className="quote-result" aria-live="polite">
              <div className="quote-totals">
                <div>
                  <span>{t.baseAmount}</span>
                  <strong>{formatVnd(quote.base_subtotal_vnd, locale)}</strong>
                </div>
                <div>
                  <span>{t.discount}</span>
                  <strong>-{formatVnd(quote.discount_vnd, locale)}</strong>
                </div>
                <div className="payable">
                  <span>{t.merchandisePayable}</span>
                  <strong>{formatVnd(quote.merchandise_payable_vnd, locale)}</strong>
                </div>
              </div>
              <p className="quote-order-pending">{t.orderPending}</p>
              <div className="promotion-table-wrap">
                <table className="promotion-table quote-table">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>{t.quantity}</th>
                      <th>{t.baseAmount}</th>
                      <th>{t.discount}</th>
                      <th>{t.merchandisePayable}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quote.lines.map((line) => (
                      <tr key={line.sku_code}>
                        <td>
                          <strong>{line.sku_code}</strong>
                          {line.issues.length > 0 && <small>{line.issues.join(' · ')}</small>}
                        </td>
                        <td>{line.quantity}</td>
                        <td>{formatVnd(line.base_subtotal_vnd, locale)}</td>
                        <td>{formatVnd(line.discount_vnd, locale)}</td>
                        <td>{formatVnd(line.payable_vnd, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="quote-rules">
                <div>
                  <h4>{t.appliedRules}</h4>
                  {quote.applied_rules.length ? (
                    quote.applied_rules.map((rule) => (
                      <p key={`${rule.bucket}:${rule.version_id}`}>
                        <span>{rule.bucket}</span>
                        <strong>{rule.code}</strong>
                        <small>{formatVnd(rule.discount_vnd ?? 0, locale)}</small>
                      </p>
                    ))
                  ) : (
                    <small>—</small>
                  )}
                </div>
                <div>
                  <h4>{t.rejectedRules}</h4>
                  {quote.rejected_rules.length ? (
                    quote.rejected_rules.map((rule) => (
                      <p key={`${rule.bucket}:${rule.version_id}`}>
                        <span>{rule.bucket}</span>
                        <strong>{rule.code}</strong>
                        <small>{rule.reason ?? '—'}</small>
                      </p>
                    ))
                  ) : (
                    <small>—</small>
                  )}
                </div>
              </div>
              <div className="quote-hash">
                <span>{t.quoteHash}</span>
                <code>{quote.quote_hash}</code>
                <small>{formatDate(quote.quoted_at, locale)}</small>
              </div>
            </div>
          ) : (
            <p className="promotion-state">{t.quoteEmpty}</p>
          )}
        </div>
      )}

      {ruleEditor && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="confirm-modal promotion-dialog"
            onSubmit={(event) => void submitRule(event)}
          >
            <div className="promotion-dialog-heading">
              <div>
                <p className="eyebrow">{t.scope}</p>
                <h2>{ruleEditor.promotion ? t.edit : t.createPromotion}</h2>
              </div>
              <button
                aria-label={t.cancel}
                className="icon-button"
                onClick={() => setRuleEditor(undefined)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="promotion-form-grid">
              <label>
                {t.code}
                <input
                  defaultValue={ruleEditor.promotion?.code ?? ''}
                  disabled={Boolean(ruleEditor.promotion)}
                  name="code"
                  pattern="[a-z][a-z0-9\-]{1,63}"
                  required
                />
              </label>
              <fieldset className="promotion-targets">
                <legend>{t.scope}</legend>
                {ruleTargets.map((target, index) => {
                  const options = targetLookupOptions[index] ?? [];
                  const selected = options.find((option) => option.id === target.target_id);
                  return (
                    <div className="promotion-target-row" key={`${index}:${target.target_type}`}>
                      <label>
                        {t.targetType}
                        <select
                          onChange={(event) => {
                            const targetType = event.target.value as PromotionTarget['target_type'];
                            targetLookupSequence.current[index] =
                              (targetLookupSequence.current[index] ?? 0) + 1;
                            setRuleTargets((current) =>
                              current.map((candidate, candidateIndex) =>
                                candidateIndex === index
                                  ? {
                                      target_id: null,
                                      target_type: targetType,
                                    }
                                  : candidate,
                              ),
                            );
                            setTargetLookupOptions((current) => ({ ...current, [index]: [] }));
                            setTargetLookupSearch((current) => ({ ...current, [index]: '' }));
                            setTargetLookupLoading((current) => ({ ...current, [index]: false }));
                            if (targetType !== 'STORE') void loadTargetOptions(index, targetType);
                          }}
                          value={target.target_type}
                        >
                          {targetTypes.map((targetType) => (
                            <option key={targetType} value={targetType}>
                              {targetType}
                            </option>
                          ))}
                        </select>
                      </label>
                      {target.target_type === 'STORE' ? (
                        <label>
                          {t.targetId}
                          <input disabled value={t.allStore} />
                        </label>
                      ) : (
                        <>
                          <label>
                            {t.targetSearch}
                            <input
                              aria-label={`${t.targetSearch} ${index + 1}`}
                              aria-busy={targetLookupLoading[index] ?? false}
                              onChange={(event) => {
                                const search = event.target.value;
                                setTargetLookupSearch((current) => ({
                                  ...current,
                                  [index]: search,
                                }));
                                void loadTargetOptions(
                                  index,
                                  target.target_type as TargetLookupType,
                                  search,
                                );
                              }}
                              placeholder={t.targetSearch}
                              value={targetLookupSearch[index] ?? ''}
                            />
                          </label>
                          <label>
                            {t.targetId}
                            <select
                              aria-label={`${t.targetId} ${index + 1}`}
                              aria-busy={targetLookupLoading[index] ?? false}
                              onChange={(event) =>
                                setRuleTargets((current) =>
                                  current.map((candidate, candidateIndex) =>
                                    candidateIndex === index
                                      ? { ...candidate, target_id: event.target.value }
                                      : candidate,
                                  ),
                                )
                              }
                              required
                              value={target.target_id ?? ''}
                            >
                              <option value="">
                                {targetLookupLoading[index] ? t.loading : t.targetSearch}
                              </option>
                              {target.target_id && !selected && (
                                <option value={target.target_id}>{target.target_id}</option>
                              )}
                              {selected && (
                                <option value={selected.id}>
                                  {targetOptionLabel(selected, locale)}
                                </option>
                              )}
                              {options
                                .filter((option) => option.id !== selected?.id)
                                .map((option) => (
                                  <option key={option.id} value={option.id}>
                                    {targetOptionLabel(option, locale)}
                                  </option>
                                ))}
                            </select>
                          </label>
                        </>
                      )}
                      <button
                        aria-label={`${t.remove} ${index + 1}`}
                        className="icon-button"
                        disabled={ruleTargets.length === 1}
                        onClick={() => {
                          setRuleTargets((current) =>
                            current.filter((_, candidateIndex) => candidateIndex !== index),
                          );
                          setTargetLookupOptions({});
                          setTargetLookupSearch({});
                          setTargetLookupLoading({});
                          targetLookupSequence.current = {};
                        }}
                        title={t.remove}
                        type="button"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
                <button
                  className="secondary"
                  disabled={ruleTargets.length >= 500}
                  onClick={() =>
                    setRuleTargets((current) => [
                      ...current,
                      { target_id: null, target_type: 'STORE' },
                    ])
                  }
                  type="button"
                >
                  + {t.addTarget}
                </button>
              </fieldset>
              <label>
                {t.bucket}
                <select
                  name="bucket"
                  onChange={(event) => {
                    const next = event.target.value as PricingBucket;
                    setRuleBucket(next);
                    setStackableWith((current) => current.filter((bucket) => bucket !== next));
                    if (next === 'SHIPPING') setBenefitMethod('FREE_SHIPPING_QUALIFICATION');
                    else if (benefitMethod === 'FREE_SHIPPING_QUALIFICATION')
                      setBenefitMethod('FIXED_VND');
                  }}
                  value={ruleBucket}
                >
                  {buckets.map((bucket) => (
                    <option key={bucket} value={bucket}>
                      {bucket}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t.benefit}
                <select
                  onChange={(event) => setBenefitMethod(event.target.value as BenefitMethod)}
                  value={benefitMethod}
                >
                  {ruleBucket === 'SHIPPING' ? (
                    <option value="FREE_SHIPPING_QUALIFICATION">{t.freeShipping}</option>
                  ) : (
                    <>
                      <option value="FIXED_VND">{t.fixed}</option>
                      <option value="PERCENTAGE_BPS">{t.percent}</option>
                    </>
                  )}
                </select>
              </label>
              {benefitMethod !== 'FREE_SHIPPING_QUALIFICATION' && (
                <label>
                  {t.benefitValue}
                  <input
                    defaultValue={
                      ruleEditor.seed?.benefit.method === benefitMethod
                        ? ruleEditor.seed.benefit.value
                        : ''
                    }
                    max={benefitMethod === 'PERCENTAGE_BPS' ? 10000 : Number.MAX_SAFE_INTEGER}
                    min={1}
                    name="benefit_value"
                    required
                    step="1"
                    type="number"
                  />
                </label>
              )}
              {benefitMethod === 'PERCENTAGE_BPS' && (
                <label>
                  {t.maxDiscount}
                  <input
                    defaultValue={
                      ruleEditor.seed?.benefit.method === 'PERCENTAGE_BPS'
                        ? (ruleEditor.seed.benefit.maximum_discount_vnd ?? '')
                        : ''
                    }
                    min={1}
                    name="maximum_discount_vnd"
                    step="1"
                    type="number"
                  />
                </label>
              )}
              <label>
                {t.minimumSpend}
                <input
                  defaultValue={ruleEditor.seed?.minimum_spend_vnd ?? ''}
                  min={0}
                  name="minimum_spend_vnd"
                  step="1"
                  type="number"
                />
              </label>
              <label>
                {t.minimumQuantity}
                <input
                  defaultValue={ruleEditor.seed?.minimum_quantity ?? ''}
                  max={99}
                  min={1}
                  name="minimum_quantity"
                  step="1"
                  type="number"
                />
              </label>
              <label>
                {t.priority}
                <input
                  defaultValue={ruleEditor.seed?.priority ?? 100}
                  max={1_000_000}
                  min={0}
                  name="priority"
                  required
                  step="1"
                  type="number"
                />
              </label>
              <label>
                {t.startTime}
                <input
                  defaultValue={toInputDate(ruleEditor.seed?.starts_at)}
                  name="starts_at"
                  required
                  type="datetime-local"
                />
              </label>
              <label>
                {t.endTime}
                <input
                  defaultValue={
                    ruleEditor.seed?.ends_at ? toInputDate(ruleEditor.seed.ends_at) : ''
                  }
                  name="ends_at"
                  type="datetime-local"
                />
              </label>
              <fieldset className="promotion-stacking">
                <legend>{t.stacking}</legend>
                {buckets.map((bucket) => (
                  <label className="check-field" key={bucket}>
                    <input
                      checked={stackableWith.includes(bucket)}
                      disabled={bucket === ruleBucket}
                      onChange={(event) =>
                        setStackableWith((current) =>
                          event.target.checked
                            ? [...current, bucket]
                            : current.filter((value) => value !== bucket),
                        )
                      }
                      type="checkbox"
                    />
                    {bucket}
                  </label>
                ))}
              </fieldset>
              {(['vi', 'zh', 'en'] as const).map((language) => {
                const localization = ruleEditor.seed?.localizations.find(
                  (item) => item.locale === language,
                );
                return (
                  <div className="promotion-localization" key={language}>
                    <strong>{language.toUpperCase()}</strong>
                    <label>
                      {language === 'vi' ? t.nameVi : language === 'zh' ? t.nameZh : t.nameEn}
                      <input
                        defaultValue={localization?.name ?? ''}
                        maxLength={240}
                        name={`name_${language}`}
                        required={language === 'vi'}
                      />
                    </label>
                    <label>
                      {language === 'vi'
                        ? t.descriptionVi
                        : language === 'zh'
                          ? t.descriptionZh
                          : t.descriptionEn}
                      <textarea
                        defaultValue={localization?.description ?? ''}
                        maxLength={2000}
                        name={`description_${language}`}
                        rows={2}
                      />
                    </label>
                  </div>
                );
              })}
            </div>
            <div className="promotion-dialog-actions">
              <button className="secondary" onClick={() => setRuleEditor(undefined)} type="button">
                {t.cancel}
              </button>
              <button className="primary" disabled={busy} type="submit">
                {busy ? t.loading : t.save}
              </button>
            </div>
          </form>
        </div>
      )}

      {couponEditor && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="confirm-modal promotion-dialog coupon-dialog"
            onSubmit={(event) => void submitCoupon(event)}
          >
            <h2>{couponEditor.coupon ? t.edit : t.createCoupon}</h2>
            <label>
              {t.code}
              <input
                defaultValue={couponEditor.coupon?.code ?? ''}
                disabled={Boolean(couponEditor.coupon)}
                name="code"
                pattern="[a-z][a-z0-9\-]{1,63}"
                required
              />
            </label>
            <label>
              {t.couponRule}
              <select
                defaultValue={couponEditor.coupon?.promotion_version_id ?? couponRuleOptions[0]?.id}
                name="promotion_version_id"
                required
              >
                {couponRuleOptions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t.limit}
              <input
                defaultValue={couponEditor.coupon?.total_claim_limit ?? ''}
                min={1}
                name="total_claim_limit"
                step="1"
                type="number"
              />
            </label>
            <label className="check-field promotion-coupon-check">
              <input
                defaultChecked={couponEditor.coupon?.new_customer_only ?? false}
                name="new_customer_only"
                type="checkbox"
              />
              {t.newCustomer}
            </label>
            <div className="promotion-dialog-actions">
              <button
                className="secondary"
                onClick={() => setCouponEditor(undefined)}
                type="button"
              >
                {t.cancel}
              </button>
              <button className="primary" disabled={busy} type="submit">
                {couponEditor.coupon ? t.save : t.create}
              </button>
            </div>
          </form>
        </div>
      )}

      {confirmation && (
        <div className="modal-backdrop" role="presentation">
          <div className="confirm-modal promotion-confirm" role="dialog" aria-modal="true">
            <p className="eyebrow">{confirmation.record.code}</p>
            <h2>{t.confirm}</h2>
            <p>{t.confirmHint}</p>
            <label>
              {confirmation.verb}
              <input
                autoFocus
                onChange={(event) => setConfirmationValue(event.target.value.toUpperCase())}
                pattern={confirmation.verb}
                value={confirmationValue}
              />
            </label>
            <div>
              <button
                className="secondary"
                onClick={() => setConfirmation(undefined)}
                type="button"
              >
                {t.cancel}
              </button>
              <button
                className={confirmation.verb === 'END' ? 'danger-button' : 'primary'}
                disabled={busy || confirmationValue !== confirmation.verb}
                onClick={() => void confirmAction()}
                type="button"
              >
                {confirmation.verb}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
