import { useEffect, useState, type FormEvent } from 'react';

type Locale = 'en' | 'vi' | 'zh';
type Store = { code: string; default_locale: Locale; id: string };
type Request = <T>(path: string, options?: RequestInit) => Promise<T>;
type BatchStatus = 'MATCHED' | 'REVIEW_REQUIRED';
type BatchSource = 'PAYMENT_PROVIDER' | 'SHIPPING_PROVIDER';
type ReviewStatus = 'OPEN' | 'CLOSED_ACCEPTED' | 'CLOSED_ESCALATED';
type ReviewDecision = Exclude<ReviewStatus, 'OPEN'>;
type LineStatus =
  | 'MATCHED'
  | 'AMOUNT_MISMATCH'
  | 'FEE_MISMATCH'
  | 'REFERENCE_NOT_FOUND'
  | 'FACT_NOT_FINAL'
  | 'COD_NOT_RECEIVABLE'
  | 'EXPECTED_FEE_NOT_FOUND'
  | 'DUPLICATE_REFERENCE';
type LineType = 'PAYMENT' | 'REFUND' | 'COD_REMITTANCE';
type BatchSummary = {
  batch_reference_masked: string;
  business_date: string;
  created_at: string;
  currency: 'VND';
  difference_vnd: number;
  exception_count: number;
  fee_amount_vnd: number;
  fee_difference_vnd: number;
  gross_amount_vnd: number;
  id: string;
  local_expected_amount_vnd: number;
  local_expected_fee_amount_vnd: number;
  matched_count: number;
  net_amount_vnd: number;
  record_count: number;
  review_status: ReviewStatus;
  source: BatchSource;
  status: BatchStatus;
  version: number;
};
type BatchLine = {
  difference_vnd: number | null;
  fee_amount_vnd: number;
  fee_difference_vnd: number | null;
  gross_amount_vnd: number;
  id: string;
  line_number: number;
  local_expected_amount_vnd: number | null;
  local_expected_fee_amount_vnd: number | null;
  net_amount_vnd: number;
  occurred_at: string;
  provider_reference_masked: string;
  record_reference_masked: string;
  status: LineStatus;
  type: LineType;
};
type ExceptionSummary = {
  difference_vnd: number;
  fee_difference_vnd: number;
  gross_amount_vnd: number;
  line_count: number;
  net_amount_vnd: number;
  status: LineStatus;
};
type BatchDetail = BatchSummary & {
  exception_summary: ExceptionSummary[];
  lines: BatchLine[];
  replayed?: boolean;
  review: {
    decision: ReviewDecision;
    id: string;
    reason: string;
    reviewed_at: string;
  } | null;
};
type BatchPage = { items: BatchSummary[]; next_cursor: string | null };
type DraftLine = {
  codFee: string;
  fee: string;
  gross: string;
  occurredAt: string;
  providerReference: string;
  recordReference: string;
  shippingFee: string;
  type: LineType;
};
type CodReceivableStatus = 'UNREMITTED' | 'REMITTED' | 'REVIEW_REQUIRED';
type CodReceivable = {
  delivered_at: string | null;
  expected_cod_amount_vnd: number;
  expected_fee_amount_vnd: number | null;
  expected_net_amount_vnd: number | null;
  id: string;
  order_number: string;
  provider_reference_masked: string | null;
  public_shipment_number: string;
  status: CodReceivableStatus;
};

const copy = {
  vi: {
    addLine: 'Thêm dòng',
    allSources: 'Tất cả nguồn',
    allStatuses: 'Tất cả trạng thái',
    allReviewStatuses: 'Tất cả kết luận',
    closedAccepted: 'Đã đóng · chấp nhận chênh lệch',
    closedEscalated: 'Đã đóng · chuyển cấp xử lý',
    batchReference: 'Mã tham chiếu lô',
    businessDate: 'Ngày nghiệp vụ',
    cancel: 'Hủy',
    closeAccepted: 'Đóng và chấp nhận chênh lệch',
    closeEscalated: 'Đóng và chuyển cấp xử lý',
    closeReview: 'Ghi nhận kết luận độc lập',
    closeReviewSuccess: 'Kết luận đối soát đã được ghi nhận.',
    confirmation: 'Tôi xác nhận dữ liệu chuẩn hóa đã được tài chính kiểm tra.',
    codEmpty: 'Chưa có khoản phải thu COD trong phạm vi này.',
    codFee: 'Phí COD',
    codReceivables: 'Khoản phải thu COD',
    codRemittance: 'GHN chuyển COD',
    difference: 'Chênh lệch',
    empty: 'Chưa có lô đối soát trong phạm vi này.',
    environment: 'Môi trường kênh',
    error: 'Không thể hoàn tất yêu cầu đối soát.',
    fee: 'Phí',
    feeDifference: 'Chênh lệch phí',
    exceptionSummary: 'Tổng hợp ngoại lệ',
    expectedCod: 'COD dự kiến',
    expectedFee: 'Phí dự kiến',
    from: 'Từ ngày',
    gross: 'Tổng tiền',
    import: 'Nhập lô',
    importAction: 'Ghi nhận lô đối soát',
    importSuccess: 'Lô đối soát đã được ghi nhận.',
    lineType: 'Loại',
    loadMore: 'Tải thêm',
    loading: 'Đang tải dữ liệu tài chính…',
    matched: 'Khớp',
    net: 'Ròng',
    openReview: 'Chờ rà soát độc lập',
    occurredAt: 'Thời điểm phát sinh',
    payment: 'Thanh toán',
    paymentSource: 'Thanh toán / hoàn tiền',
    providerReference: 'Tham chiếu nhà cung cấp',
    reason: 'Lý do nhập',
    reviewConfirmation: 'Tôi xác nhận người nhập lô không thực hiện bước đóng này.',
    reviewDecision: 'Kết luận rà soát',
    reviewReason: 'Lý do kết luận',
    reviewResult: 'Kết quả rà soát độc lập',
    reviewedAt: 'Thời điểm kết luận',
    recordReference: 'Tham chiếu dòng',
    refresh: 'Làm mới',
    remittanceCod: 'COD đã chuyển',
    refund: 'Hoàn tiền',
    remitted: 'Đã chuyển',
    removeLine: 'Xóa dòng',
    review: 'Cần kiểm tra',
    shippingFee: 'Phí vận chuyển',
    shippingSource: 'GHN / COD',
    source: 'Nguồn',
    title: 'Đối soát tài chính',
    to: 'Đến ngày',
    total: 'Tổng dòng',
    unremitted: 'Chưa chuyển',
    view: 'Xem chi tiết',
  },
  zh: {
    addLine: '添加记录',
    allSources: '全部来源',
    allStatuses: '全部状态',
    allReviewStatuses: '全部复核结论',
    closedAccepted: '已关闭 · 接受差异',
    closedEscalated: '已关闭 · 升级处理',
    batchReference: '批次引用',
    businessDate: '业务日期',
    cancel: '取消',
    closeAccepted: '关闭并接受差异',
    closeEscalated: '关闭并升级处理',
    closeReview: '记录独立复核结论',
    closeReviewSuccess: '对账复核结论已记录。',
    confirmation: '我确认财务已复核该规范化数据。',
    codEmpty: '当前范围暂无 COD 应收。',
    codFee: 'COD 手续费',
    codReceivables: 'COD 应收清单',
    codRemittance: 'GHN COD 回款',
    difference: '差异',
    empty: '当前范围暂无财务对账批次。',
    environment: '渠道环境',
    error: '财务对账请求未能完成。',
    fee: '手续费',
    feeDifference: '费用差异',
    exceptionSummary: '异常分类汇总',
    expectedCod: '应收 COD',
    expectedFee: '预期费用',
    from: '开始日期',
    gross: '总额',
    import: '导入批次',
    importAction: '记录对账批次',
    importSuccess: '对账批次已记录。',
    lineType: '类型',
    loadMore: '加载更多',
    loading: '正在加载财务数据…',
    matched: '已匹配',
    net: '净额',
    openReview: '等待独立复核',
    occurredAt: '发生时间',
    payment: '支付',
    paymentSource: '支付 / 退款',
    providerReference: '供应商引用',
    reason: '导入原因',
    reviewConfirmation: '我确认本次关闭操作人与批次导入人不同。',
    reviewDecision: '复核结论',
    reviewReason: '结论原因',
    reviewResult: '独立复核结果',
    reviewedAt: '结论时间',
    recordReference: '记录引用',
    refresh: '刷新',
    remittanceCod: '回款 COD',
    refund: '退款',
    remitted: '已回款',
    removeLine: '删除记录',
    review: '需要复核',
    shippingFee: '运费',
    shippingSource: 'GHN / COD',
    source: '来源',
    title: '财务对账',
    to: '结束日期',
    total: '记录总数',
    unremitted: '未回款',
    view: '查看详情',
  },
  en: {
    addLine: 'Add record',
    allSources: 'All sources',
    allStatuses: 'All statuses',
    allReviewStatuses: 'All review outcomes',
    closedAccepted: 'Closed · variance accepted',
    closedEscalated: 'Closed · escalated',
    batchReference: 'Batch reference',
    businessDate: 'Business date',
    cancel: 'Cancel',
    closeAccepted: 'Close and accept variance',
    closeEscalated: 'Close and escalate variance',
    closeReview: 'Record independent review',
    closeReviewSuccess: 'The reconciliation review was recorded.',
    confirmation: 'I confirm finance reviewed this normalized data.',
    codEmpty: 'No COD receivables exist in this scope.',
    codFee: 'COD fee',
    codReceivables: 'COD receivables',
    codRemittance: 'GHN COD remittance',
    difference: 'Difference',
    empty: 'No financial reconciliation batches exist in this scope.',
    environment: 'Channel environment',
    error: 'The financial reconciliation request could not be completed.',
    fee: 'Fee',
    feeDifference: 'Fee difference',
    exceptionSummary: 'Exception summary',
    expectedCod: 'Expected COD',
    expectedFee: 'Expected fee',
    from: 'From date',
    gross: 'Gross',
    import: 'Import batch',
    importAction: 'Record reconciliation batch',
    importSuccess: 'The reconciliation batch was recorded.',
    lineType: 'Type',
    loadMore: 'Load more',
    loading: 'Loading financial data…',
    matched: 'Matched',
    net: 'Net',
    openReview: 'Awaiting independent review',
    occurredAt: 'Occurred at',
    payment: 'Payment',
    paymentSource: 'Payment / refund',
    providerReference: 'Provider reference',
    reason: 'Import reason',
    reviewConfirmation: 'I confirm the batch importer is not performing this closeout.',
    reviewDecision: 'Review outcome',
    reviewReason: 'Review reason',
    reviewResult: 'Independent review result',
    reviewedAt: 'Reviewed at',
    recordReference: 'Record reference',
    refresh: 'Refresh',
    remittanceCod: 'Remitted COD',
    refund: 'Refund',
    remitted: 'Remitted',
    removeLine: 'Remove record',
    review: 'Review required',
    shippingFee: 'Shipping fee',
    shippingSource: 'GHN / COD',
    source: 'Source',
    title: 'Financial reconciliation',
    to: 'To date',
    total: 'Total records',
    unremitted: 'Unremitted',
    view: 'View details',
  },
} as const;

const statusCopy: Record<Locale, Record<BatchStatus | LineStatus, string>> = {
  vi: {
    AMOUNT_MISMATCH: 'Lệch số tiền',
    COD_NOT_RECEIVABLE: 'Không phải khoản phải thu COD',
    DUPLICATE_REFERENCE: 'Trùng tham chiếu',
    FACT_NOT_FINAL: 'Dữ kiện chưa cuối',
    EXPECTED_FEE_NOT_FOUND: 'Thiếu phí dự kiến',
    FEE_MISMATCH: 'Lệch phí',
    MATCHED: 'Khớp',
    REFERENCE_NOT_FOUND: 'Không tìm thấy tham chiếu',
    REVIEW_REQUIRED: 'Cần kiểm tra',
  },
  zh: {
    AMOUNT_MISMATCH: '金额不符',
    COD_NOT_RECEIVABLE: '非 COD 应收',
    DUPLICATE_REFERENCE: '引用重复',
    FACT_NOT_FINAL: '事实未终态',
    EXPECTED_FEE_NOT_FOUND: '预期费用缺失',
    FEE_MISMATCH: '费用不符',
    MATCHED: '已匹配',
    REFERENCE_NOT_FOUND: '引用不存在',
    REVIEW_REQUIRED: '需要复核',
  },
  en: {
    AMOUNT_MISMATCH: 'Amount mismatch',
    COD_NOT_RECEIVABLE: 'COD not receivable',
    DUPLICATE_REFERENCE: 'Duplicate reference',
    FACT_NOT_FINAL: 'Fact not final',
    EXPECTED_FEE_NOT_FOUND: 'Expected fee missing',
    FEE_MISMATCH: 'Fee mismatch',
    MATCHED: 'Matched',
    REFERENCE_NOT_FOUND: 'Reference not found',
    REVIEW_REQUIRED: 'Review required',
  },
};

const reviewStatusCopy: Record<Locale, Record<ReviewStatus, string>> = {
  vi: {
    CLOSED_ACCEPTED: copy.vi.closedAccepted,
    CLOSED_ESCALATED: copy.vi.closedEscalated,
    OPEN: copy.vi.openReview,
  },
  zh: {
    CLOSED_ACCEPTED: copy.zh.closedAccepted,
    CLOSED_ESCALATED: copy.zh.closedEscalated,
    OPEN: copy.zh.openReview,
  },
  en: {
    CLOSED_ACCEPTED: copy.en.closedAccepted,
    CLOSED_ESCALATED: copy.en.closedEscalated,
    OPEN: copy.en.openReview,
  },
};

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

function localDateTime(): string {
  const now = new Date();
  return `${today()}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(
    2,
    '0',
  )}`;
}

function newLine(index: number, source: BatchSource = 'PAYMENT_PROVIDER'): DraftLine {
  return {
    codFee: '0',
    fee: '0',
    gross: '',
    occurredAt: localDateTime(),
    providerReference: '',
    recordReference: `line-${index}`,
    shippingFee: '0',
    type: source === 'SHIPPING_PROVIDER' ? 'COD_REMITTANCE' : 'PAYMENT',
  };
}

function formatVnd(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === 'vi' ? 'vi-VN' : locale === 'zh' ? 'zh-CN' : 'en-US', {
    currency: 'VND',
    maximumFractionDigits: 0,
    style: 'currency',
  }).format(value);
}

function formatDateTime(value: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : locale === 'zh' ? 'zh-CN' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function FinancialReconciliationWorkbench({
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
  const [items, setItems] = useState<BatchSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'' | BatchStatus>('');
  const [source, setSource] = useState<'' | BatchSource>('');
  const [reviewStatus, setReviewStatus] = useState<'' | ReviewStatus>('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [detail, setDetail] = useState<BatchDetail>();
  const [importOpen, setImportOpen] = useState(false);
  const [importSource, setImportSource] = useState<BatchSource>('PAYMENT_PROVIDER');
  const [receivables, setReceivables] = useState<CodReceivable[]>([]);
  const [receivablesBusy, setReceivablesBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [success, setSuccess] = useState(false);
  const [reviewSuccess, setReviewSuccess] = useState(false);
  const [batchReference, setBatchReference] = useState('');
  const [businessDate, setBusinessDate] = useState(today());
  const [environment, setEnvironment] = useState<'SANDBOX' | 'PRODUCTION'>('SANDBOX');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([newLine(1)]);
  const [reviewDecision, setReviewDecision] = useState<ReviewDecision>('CLOSED_ESCALATED');
  const [reviewReason, setReviewReason] = useState('');
  const [reviewConfirmed, setReviewConfirmed] = useState(false);

  const load = async (append = false, nextCursor: string | null = null): Promise<void> => {
    setBusy(true);
    setError(false);
    try {
      const query = new URLSearchParams({ limit: '20', store_id: store.id });
      if (status) query.set('status', status);
      if (source) query.set('source', source);
      if (reviewStatus) query.set('review_status', reviewStatus);
      if (dateFrom) query.set('business_date_from', dateFrom);
      if (dateTo) query.set('business_date_to', dateTo);
      if (nextCursor) query.set('cursor', nextCursor);
      const page = await request<BatchPage>(
        `/v1/admin/financial-reconciliation/batches?${query.toString()}`,
        { headers: headers() },
      );
      setItems((current) => (append ? [...current, ...page.items] : page.items));
      setCursor(page.next_cursor);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const loadReceivables = async (): Promise<void> => {
    setReceivablesBusy(true);
    try {
      const page = await request<{ items: CodReceivable[] }>(
        `/v1/admin/financial-reconciliation/cod-receivables?store_id=${encodeURIComponent(store.id)}&limit=20`,
        { headers: headers() },
      );
      setReceivables(page.items);
    } catch {
      setError(true);
    } finally {
      setReceivablesBusy(false);
    }
  };

  useEffect(() => {
    void load();
  }, [store.id, status, source, reviewStatus, dateFrom, dateTo]);

  useEffect(() => {
    void loadReceivables();
  }, [store.id]);

  useEffect(() => {
    setDetail(undefined);
    setImportOpen(false);
    setReviewReason('');
    setReviewConfirmed(false);
    setReviewSuccess(false);
  }, [store.id]);

  const showDetail = async (batchId: string): Promise<void> => {
    setBusy(true);
    setError(false);
    setReviewReason('');
    setReviewConfirmed(false);
    try {
      setDetail(
        await request<BatchDetail>(
          `/v1/admin/financial-reconciliation/batches/${batchId}?store_id=${encodeURIComponent(store.id)}`,
          { headers: headers() },
        ),
      );
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const closeReview = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!detail || !reviewConfirmed || detail.review_status !== 'OPEN') return;
    setBusy(true);
    setError(false);
    setReviewSuccess(false);
    try {
      await request(
        `/v1/admin/financial-reconciliation/batches/${detail.id}/review?store_id=${encodeURIComponent(store.id)}`,
        {
          body: JSON.stringify({
            confirmation_code: 'CLOSE_FINANCIAL_RECONCILIATION',
            decision: reviewDecision,
            expected_batch_version: detail.version,
            reason: reviewReason,
          }),
          headers: {
            ...headers(),
            'Content-Type': 'application/json',
            'Idempotency-Key': `financial-reconciliation-review:${crypto.randomUUID()}`,
          },
          method: 'POST',
        },
      );
      setReviewSuccess(true);
      setReviewReason('');
      setReviewConfirmed(false);
      await Promise.all([load(), showDetail(detail.id)]);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const updateLine = (index: number, patch: Partial<DraftLine>): void => {
    setLines((current) =>
      current.map((line, lineIndex) => (lineIndex === index ? { ...line, ...patch } : line)),
    );
  };

  const importBatch = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!confirmed) return;
    setBusy(true);
    setError(false);
    setSuccess(false);
    try {
      const cod = importSource === 'SHIPPING_PROVIDER';
      const result = await request<BatchDetail>(
        `/v1/admin/financial-reconciliation/${cod ? 'cod-batches' : 'payment-batches'}?store_id=${encodeURIComponent(store.id)}`,
        {
          body: JSON.stringify({
            batch_reference: batchReference,
            business_date: businessDate,
            confirmation_code: cod ? 'IMPORT_GHN_COD_SETTLEMENT' : 'IMPORT_PAYMENT_SETTLEMENT',
            provider_code: cod ? 'GHN' : 'ZALO_CHECKOUT_ZALOPAY',
            provider_environment: environment,
            reason,
            records: lines.map((line) =>
              cod
                ? {
                    cod_amount_vnd: Number(line.gross),
                    cod_fee_vnd: Number(line.codFee),
                    occurred_at: new Date(line.occurredAt).toISOString(),
                    provider_reference: line.providerReference,
                    record_reference: line.recordReference,
                    shipping_fee_vnd: Number(line.shippingFee),
                  }
                : {
                    fee_amount_vnd: Number(line.fee),
                    gross_amount_vnd: Number(line.gross),
                    occurred_at: new Date(line.occurredAt).toISOString(),
                    provider_reference: line.providerReference,
                    record_reference: line.recordReference,
                    type: line.type,
                  },
            ),
          }),
          headers: {
            ...headers(),
            'Content-Type': 'application/json',
            'Idempotency-Key': `financial-reconciliation:${crypto.randomUUID()}`,
          },
          method: 'POST',
        },
      );
      setSuccess(true);
      setImportOpen(false);
      setBatchReference('');
      setReason('');
      setConfirmed(false);
      setImportSource('PAYMENT_PROVIDER');
      setLines([newLine(1)]);
      await Promise.all([load(), loadReceivables(), showDetail(result.id)]);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="data-section reconciliation-workbench">
      <div className="section-heading reconciliation-heading">
        <div>
          <p className="eyebrow">P0-M5-005</p>
          <h2>{t.title}</h2>
        </div>
        <div className="reconciliation-actions">
          <button className="secondary" disabled={busy} onClick={() => void load()} type="button">
            {t.refresh}
          </button>
          <button className="primary" onClick={() => setImportOpen(true)} type="button">
            {t.import}
          </button>
        </div>
      </div>

      <div className="reconciliation-filters">
        <label>
          {t.allSources}
          <select
            onChange={(event) => setSource(event.target.value as '' | BatchSource)}
            value={source}
          >
            <option value="">{t.allSources}</option>
            <option value="PAYMENT_PROVIDER">{t.paymentSource}</option>
            <option value="SHIPPING_PROVIDER">{t.shippingSource}</option>
          </select>
        </label>
        <label>
          {t.allStatuses}
          <select
            onChange={(event) => setStatus(event.target.value as '' | BatchStatus)}
            value={status}
          >
            <option value="">{t.allStatuses}</option>
            <option value="MATCHED">{t.matched}</option>
            <option value="REVIEW_REQUIRED">{t.review}</option>
          </select>
        </label>
        <label>
          {t.allReviewStatuses}
          <select
            onChange={(event) => setReviewStatus(event.target.value as '' | ReviewStatus)}
            value={reviewStatus}
          >
            <option value="">{t.allReviewStatuses}</option>
            <option value="OPEN">{t.openReview}</option>
            <option value="CLOSED_ACCEPTED">{t.closedAccepted}</option>
            <option value="CLOSED_ESCALATED">{t.closedEscalated}</option>
          </select>
        </label>
        <label>
          {t.from}
          <input
            onChange={(event) => setDateFrom(event.target.value)}
            type="date"
            value={dateFrom}
          />
        </label>
        <label>
          {t.to}
          <input onChange={(event) => setDateTo(event.target.value)} type="date" value={dateTo} />
        </label>
      </div>

      {error && <p className="workbench-message error">{t.error}</p>}
      {success && <p className="workbench-message success">{t.importSuccess}</p>}
      {reviewSuccess && <p className="workbench-message success">{t.closeReviewSuccess}</p>}
      {busy && items.length === 0 ? (
        <p className="empty-state">{t.loading}</p>
      ) : items.length === 0 ? (
        <p className="empty-state">{t.empty}</p>
      ) : (
        <div className="reconciliation-table-wrap">
          <table className="reconciliation-table">
            <thead>
              <tr>
                <th>{t.businessDate}</th>
                <th>{t.batchReference}</th>
                <th>{t.total}</th>
                <th>{t.gross}</th>
                <th>{t.fee}</th>
                <th>{t.difference}</th>
                <th>{t.allStatuses}</th>
                <th>{t.reviewDecision}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((batch) => (
                <tr key={batch.id}>
                  <td>{batch.business_date}</td>
                  <td>{batch.batch_reference_masked}</td>
                  <td>{batch.record_count}</td>
                  <td>{formatVnd(batch.gross_amount_vnd, locale)}</td>
                  <td>{formatVnd(batch.fee_amount_vnd, locale)}</td>
                  <td>{formatVnd(batch.difference_vnd, locale)}</td>
                  <td>
                    <span className={`reconciliation-status status-${batch.status.toLowerCase()}`}>
                      {statusCopy[locale][batch.status]}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`reconciliation-status status-${batch.review_status.toLowerCase()}`}
                    >
                      {reviewStatusCopy[locale][batch.review_status]}
                    </span>
                  </td>
                  <td>
                    <button
                      className="secondary compact"
                      onClick={() => void showDetail(batch.id)}
                      type="button"
                    >
                      {t.view}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor && (
        <button
          className="secondary reconciliation-more"
          disabled={busy}
          onClick={() => void load(true, cursor)}
          type="button"
        >
          {busy ? t.loading : t.loadMore}
        </button>
      )}

      <div className="section-heading reconciliation-heading">
        <div>
          <p className="eyebrow">GHN</p>
          <h3>{t.codReceivables}</h3>
        </div>
        <button
          className="secondary"
          disabled={receivablesBusy}
          onClick={() => void loadReceivables()}
          type="button"
        >
          {receivablesBusy ? t.loading : t.refresh}
        </button>
      </div>
      {receivablesBusy && receivables.length === 0 ? (
        <p className="empty-state">{t.loading}</p>
      ) : receivables.length === 0 ? (
        <p className="empty-state">{t.codEmpty}</p>
      ) : (
        <div className="reconciliation-table-wrap">
          <table className="reconciliation-table">
            <thead>
              <tr>
                <th>{t.providerReference}</th>
                <th>{t.expectedCod}</th>
                <th>{t.expectedFee}</th>
                <th>{t.net}</th>
                <th>{t.allStatuses}</th>
              </tr>
            </thead>
            <tbody>
              {receivables.map((receivable) => (
                <tr key={receivable.id}>
                  <td>
                    {receivable.public_shipment_number}
                    <br />
                    <small>
                      {receivable.order_number} · {receivable.provider_reference_masked ?? '-'}
                    </small>
                  </td>
                  <td>{formatVnd(receivable.expected_cod_amount_vnd, locale)}</td>
                  <td>
                    {receivable.expected_fee_amount_vnd === null
                      ? statusCopy[locale].EXPECTED_FEE_NOT_FOUND
                      : formatVnd(receivable.expected_fee_amount_vnd, locale)}
                  </td>
                  <td>
                    {receivable.expected_net_amount_vnd === null
                      ? '-'
                      : formatVnd(receivable.expected_net_amount_vnd, locale)}
                  </td>
                  <td>
                    <span
                      className={`reconciliation-status status-${receivable.status.toLowerCase()}`}
                    >
                      {receivable.status === 'UNREMITTED'
                        ? t.unremitted
                        : receivable.status === 'REMITTED'
                          ? t.remitted
                          : t.review}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <div className="reconciliation-detail">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{detail.batch_reference_masked}</p>
              <h3>{statusCopy[locale][detail.status]}</h3>
              <span
                className={`reconciliation-status status-${detail.review_status.toLowerCase()}`}
              >
                {reviewStatusCopy[locale][detail.review_status]}
              </span>
            </div>
            <button
              aria-label={t.cancel}
              className="icon-button"
              onClick={() => setDetail(undefined)}
              title={t.cancel}
              type="button"
            >
              ×
            </button>
          </div>
          <dl className="reconciliation-summary">
            <div>
              <dt>{t.gross}</dt>
              <dd>{formatVnd(detail.gross_amount_vnd, locale)}</dd>
            </div>
            <div>
              <dt>{t.fee}</dt>
              <dd>{formatVnd(detail.fee_amount_vnd, locale)}</dd>
            </div>
            <div>
              <dt>{t.net}</dt>
              <dd>{formatVnd(detail.net_amount_vnd, locale)}</dd>
            </div>
            <div>
              <dt>{t.difference}</dt>
              <dd>{formatVnd(detail.difference_vnd, locale)}</dd>
            </div>
            <div>
              <dt>{t.feeDifference}</dt>
              <dd>{formatVnd(detail.fee_difference_vnd, locale)}</dd>
            </div>
          </dl>
          {detail.exception_summary.length > 0 && (
            <div className="reconciliation-exceptions">
              <h4>{t.exceptionSummary}</h4>
              <div className="reconciliation-table-wrap">
                <table className="reconciliation-table">
                  <thead>
                    <tr>
                      <th>{t.allStatuses}</th>
                      <th>{t.total}</th>
                      <th>{t.gross}</th>
                      <th>{t.net}</th>
                      <th>{t.difference}</th>
                      <th>{t.feeDifference}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.exception_summary.map((summary) => (
                      <tr key={summary.status}>
                        <td>{statusCopy[locale][summary.status]}</td>
                        <td>{summary.line_count}</td>
                        <td>{formatVnd(summary.gross_amount_vnd, locale)}</td>
                        <td>{formatVnd(summary.net_amount_vnd, locale)}</td>
                        <td>{formatVnd(summary.difference_vnd, locale)}</td>
                        <td>{formatVnd(summary.fee_difference_vnd, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {detail.review ? (
            <div className="reconciliation-review-result">
              <h4>{t.reviewResult}</h4>
              <dl>
                <div>
                  <dt>{t.reviewDecision}</dt>
                  <dd>{reviewStatusCopy[locale][detail.review.decision]}</dd>
                </div>
                <div>
                  <dt>{t.reviewedAt}</dt>
                  <dd>{formatDateTime(detail.review.reviewed_at, locale)}</dd>
                </div>
                <div className="wide">
                  <dt>{t.reviewReason}</dt>
                  <dd>{detail.review.reason}</dd>
                </div>
              </dl>
            </div>
          ) : detail.status === 'REVIEW_REQUIRED' ? (
            <form className="reconciliation-review" onSubmit={(event) => void closeReview(event)}>
              <h4>{t.closeReview}</h4>
              <div className="reconciliation-review-fields">
                <label>
                  {t.reviewDecision}
                  <select
                    onChange={(event) => setReviewDecision(event.target.value as ReviewDecision)}
                    value={reviewDecision}
                  >
                    <option value="CLOSED_ACCEPTED">{t.closeAccepted}</option>
                    <option value="CLOSED_ESCALATED">{t.closeEscalated}</option>
                  </select>
                </label>
                <label>
                  {t.reviewReason}
                  <textarea
                    maxLength={500}
                    minLength={10}
                    onChange={(event) => setReviewReason(event.target.value)}
                    required
                    value={reviewReason}
                  />
                </label>
              </div>
              <label className="reconciliation-confirm">
                <input
                  checked={reviewConfirmed}
                  onChange={(event) => setReviewConfirmed(event.target.checked)}
                  type="checkbox"
                />
                {t.reviewConfirmation}
              </label>
              <div className="reconciliation-form-actions">
                <button className="primary" disabled={busy || !reviewConfirmed} type="submit">
                  {busy ? t.loading : t.closeReview}
                </button>
              </div>
            </form>
          ) : null}
          <div className="reconciliation-lines">
            {detail.lines.map((line) => (
              <article key={line.id}>
                <div>
                  <strong>
                    {line.type === 'PAYMENT'
                      ? t.payment
                      : line.type === 'REFUND'
                        ? t.refund
                        : t.codRemittance}
                  </strong>
                  <small>
                    {line.record_reference_masked} · {line.provider_reference_masked}
                  </small>
                </div>
                <span>{formatVnd(line.gross_amount_vnd, locale)}</span>
                <span className={`reconciliation-status status-${line.status.toLowerCase()}`}>
                  {statusCopy[locale][line.status]}
                </span>
              </article>
            ))}
          </div>
        </div>
      )}

      {importOpen && (
        <div className="reconciliation-import">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{importSource}</p>
              <h3>{t.import}</h3>
            </div>
            <button
              aria-label={t.cancel}
              className="icon-button"
              onClick={() => setImportOpen(false)}
              title={t.cancel}
              type="button"
            >
              ×
            </button>
          </div>
          <form onSubmit={(event) => void importBatch(event)}>
            <div className="reconciliation-import-meta">
              <label>
                {t.source}
                <select
                  onChange={(event) => {
                    const nextSource = event.target.value as BatchSource;
                    setImportSource(nextSource);
                    setLines((current) =>
                      current.map((line) => ({
                        ...line,
                        type: nextSource === 'SHIPPING_PROVIDER' ? 'COD_REMITTANCE' : 'PAYMENT',
                      })),
                    );
                  }}
                  value={importSource}
                >
                  <option value="PAYMENT_PROVIDER">{t.paymentSource}</option>
                  <option value="SHIPPING_PROVIDER">{t.shippingSource}</option>
                </select>
              </label>
              <label>
                {t.batchReference}
                <input
                  maxLength={160}
                  onChange={(event) => setBatchReference(event.target.value)}
                  required
                  value={batchReference}
                />
              </label>
              <label>
                {t.businessDate}
                <input
                  onChange={(event) => setBusinessDate(event.target.value)}
                  required
                  type="date"
                  value={businessDate}
                />
              </label>
              <label>
                {t.environment}
                <select
                  onChange={(event) =>
                    setEnvironment(event.target.value as 'SANDBOX' | 'PRODUCTION')
                  }
                  value={environment}
                >
                  <option value="SANDBOX">SANDBOX</option>
                  <option value="PRODUCTION">PRODUCTION</option>
                </select>
              </label>
              <label className="wide">
                {t.reason}
                <textarea
                  minLength={10}
                  maxLength={500}
                  onChange={(event) => setReason(event.target.value)}
                  required
                  value={reason}
                />
              </label>
            </div>
            <div className="reconciliation-draft-lines">
              {lines.map((line, index) => (
                <fieldset key={`${index}-${line.recordReference}`}>
                  <label>
                    {t.lineType}
                    <select
                      disabled={importSource === 'SHIPPING_PROVIDER'}
                      onChange={(event) =>
                        updateLine(index, { type: event.target.value as LineType })
                      }
                      value={line.type}
                    >
                      <option value="PAYMENT">{t.payment}</option>
                      <option value="REFUND">{t.refund}</option>
                      <option value="COD_REMITTANCE">{t.codRemittance}</option>
                    </select>
                  </label>
                  <label>
                    {t.recordReference}
                    <input
                      maxLength={160}
                      onChange={(event) =>
                        updateLine(index, { recordReference: event.target.value })
                      }
                      required
                      value={line.recordReference}
                    />
                  </label>
                  <label>
                    {t.providerReference}
                    <input
                      maxLength={160}
                      onChange={(event) =>
                        updateLine(index, { providerReference: event.target.value })
                      }
                      required
                      value={line.providerReference}
                    />
                  </label>
                  <label>
                    {t.occurredAt}
                    <input
                      onChange={(event) => updateLine(index, { occurredAt: event.target.value })}
                      required
                      type="datetime-local"
                      value={line.occurredAt}
                    />
                  </label>
                  <label>
                    {importSource === 'SHIPPING_PROVIDER' ? t.remittanceCod : t.gross}
                    <input
                      max={Number.MAX_SAFE_INTEGER}
                      min="1"
                      onChange={(event) => updateLine(index, { gross: event.target.value })}
                      required
                      step="1"
                      type="number"
                      value={line.gross}
                    />
                  </label>
                  {importSource === 'SHIPPING_PROVIDER' ? (
                    <>
                      <label>
                        {t.shippingFee}
                        <input
                          max={Number.MAX_SAFE_INTEGER}
                          min="0"
                          onChange={(event) =>
                            updateLine(index, { shippingFee: event.target.value })
                          }
                          required
                          step="1"
                          type="number"
                          value={line.shippingFee}
                        />
                      </label>
                      <label>
                        {t.codFee}
                        <input
                          max={Number.MAX_SAFE_INTEGER}
                          min="0"
                          onChange={(event) => updateLine(index, { codFee: event.target.value })}
                          required
                          step="1"
                          type="number"
                          value={line.codFee}
                        />
                      </label>
                    </>
                  ) : (
                    <label>
                      {t.fee}
                      <input
                        max={Number.MAX_SAFE_INTEGER}
                        min="0"
                        onChange={(event) => updateLine(index, { fee: event.target.value })}
                        required
                        step="1"
                        type="number"
                        value={line.fee}
                      />
                    </label>
                  )}
                  <button
                    aria-label={t.removeLine}
                    className="icon-button"
                    disabled={lines.length === 1}
                    onClick={() =>
                      setLines((current) => current.filter((_, lineIndex) => lineIndex !== index))
                    }
                    title={t.removeLine}
                    type="button"
                  >
                    ×
                  </button>
                </fieldset>
              ))}
            </div>
            <button
              className="secondary"
              disabled={lines.length >= 500}
              onClick={() =>
                setLines((current) => [...current, newLine(current.length + 1, importSource)])
              }
              type="button"
            >
              + {t.addLine}
            </button>
            <label className="reconciliation-confirm">
              <input
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                type="checkbox"
              />
              {t.confirmation}
            </label>
            <div className="reconciliation-form-actions">
              <button className="secondary" onClick={() => setImportOpen(false)} type="button">
                {t.cancel}
              </button>
              <button className="primary" disabled={busy || !confirmed} type="submit">
                {busy ? t.loading : t.importAction}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
