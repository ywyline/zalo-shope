import { useEffect, useState, type FormEvent } from 'react';

type Locale = 'en' | 'vi' | 'zh';
type Store = { code: string; default_locale: Locale; id: string };
type Request = <T>(path: string, options?: RequestInit) => Promise<T>;
type BatchStatus = 'MATCHED' | 'REVIEW_REQUIRED';
type LineStatus =
  'MATCHED' | 'AMOUNT_MISMATCH' | 'REFERENCE_NOT_FOUND' | 'FACT_NOT_FINAL' | 'DUPLICATE_REFERENCE';
type LineType = 'PAYMENT' | 'REFUND';
type BatchSummary = {
  batch_reference_masked: string;
  business_date: string;
  created_at: string;
  currency: 'VND';
  difference_vnd: number;
  exception_count: number;
  fee_amount_vnd: number;
  gross_amount_vnd: number;
  id: string;
  local_expected_amount_vnd: number;
  matched_count: number;
  net_amount_vnd: number;
  record_count: number;
  source: 'PAYMENT_PROVIDER';
  status: BatchStatus;
  version: number;
};
type BatchLine = {
  difference_vnd: number | null;
  fee_amount_vnd: number;
  gross_amount_vnd: number;
  id: string;
  line_number: number;
  local_expected_amount_vnd: number | null;
  net_amount_vnd: number;
  occurred_at: string;
  provider_reference_masked: string;
  record_reference_masked: string;
  status: LineStatus;
  type: LineType;
};
type BatchDetail = BatchSummary & { lines: BatchLine[]; replayed?: boolean };
type BatchPage = { items: BatchSummary[]; next_cursor: string | null };
type DraftLine = {
  fee: string;
  gross: string;
  occurredAt: string;
  providerReference: string;
  recordReference: string;
  type: LineType;
};

const copy = {
  vi: {
    addLine: 'Thêm dòng',
    allStatuses: 'Tất cả trạng thái',
    batchReference: 'Mã tham chiếu lô',
    businessDate: 'Ngày nghiệp vụ',
    cancel: 'Hủy',
    confirmation: 'Tôi xác nhận dữ liệu chuẩn hóa đã được tài chính kiểm tra.',
    difference: 'Chênh lệch',
    empty: 'Chưa có lô đối soát trong phạm vi này.',
    environment: 'Môi trường kênh',
    error: 'Không thể hoàn tất yêu cầu đối soát.',
    fee: 'Phí',
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
    occurredAt: 'Thời điểm phát sinh',
    payment: 'Thanh toán',
    providerReference: 'Tham chiếu nhà cung cấp',
    reason: 'Lý do nhập',
    recordReference: 'Tham chiếu dòng',
    refresh: 'Làm mới',
    refund: 'Hoàn tiền',
    removeLine: 'Xóa dòng',
    review: 'Cần kiểm tra',
    title: 'Đối soát tài chính',
    to: 'Đến ngày',
    total: 'Tổng dòng',
    view: 'Xem chi tiết',
  },
  zh: {
    addLine: '添加记录',
    allStatuses: '全部状态',
    batchReference: '批次引用',
    businessDate: '业务日期',
    cancel: '取消',
    confirmation: '我确认财务已复核该规范化数据。',
    difference: '差异',
    empty: '当前范围暂无财务对账批次。',
    environment: '渠道环境',
    error: '财务对账请求未能完成。',
    fee: '手续费',
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
    occurredAt: '发生时间',
    payment: '支付',
    providerReference: '供应商引用',
    reason: '导入原因',
    recordReference: '记录引用',
    refresh: '刷新',
    refund: '退款',
    removeLine: '删除记录',
    review: '需要复核',
    title: '财务对账',
    to: '结束日期',
    total: '记录总数',
    view: '查看详情',
  },
  en: {
    addLine: 'Add record',
    allStatuses: 'All statuses',
    batchReference: 'Batch reference',
    businessDate: 'Business date',
    cancel: 'Cancel',
    confirmation: 'I confirm finance reviewed this normalized data.',
    difference: 'Difference',
    empty: 'No financial reconciliation batches exist in this scope.',
    environment: 'Channel environment',
    error: 'The financial reconciliation request could not be completed.',
    fee: 'Fee',
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
    occurredAt: 'Occurred at',
    payment: 'Payment',
    providerReference: 'Provider reference',
    reason: 'Import reason',
    recordReference: 'Record reference',
    refresh: 'Refresh',
    refund: 'Refund',
    removeLine: 'Remove record',
    review: 'Review required',
    title: 'Financial reconciliation',
    to: 'To date',
    total: 'Total records',
    view: 'View details',
  },
} as const;

const statusCopy: Record<Locale, Record<BatchStatus | LineStatus, string>> = {
  vi: {
    AMOUNT_MISMATCH: 'Lệch số tiền',
    DUPLICATE_REFERENCE: 'Trùng tham chiếu',
    FACT_NOT_FINAL: 'Dữ kiện chưa cuối',
    MATCHED: 'Khớp',
    REFERENCE_NOT_FOUND: 'Không tìm thấy tham chiếu',
    REVIEW_REQUIRED: 'Cần kiểm tra',
  },
  zh: {
    AMOUNT_MISMATCH: '金额不符',
    DUPLICATE_REFERENCE: '引用重复',
    FACT_NOT_FINAL: '事实未终态',
    MATCHED: '已匹配',
    REFERENCE_NOT_FOUND: '引用不存在',
    REVIEW_REQUIRED: '需要复核',
  },
  en: {
    AMOUNT_MISMATCH: 'Amount mismatch',
    DUPLICATE_REFERENCE: 'Duplicate reference',
    FACT_NOT_FINAL: 'Fact not final',
    MATCHED: 'Matched',
    REFERENCE_NOT_FOUND: 'Reference not found',
    REVIEW_REQUIRED: 'Review required',
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

function newLine(index: number): DraftLine {
  return {
    fee: '0',
    gross: '',
    occurredAt: localDateTime(),
    providerReference: '',
    recordReference: `line-${index}`,
    type: 'PAYMENT',
  };
}

function formatVnd(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === 'vi' ? 'vi-VN' : locale === 'zh' ? 'zh-CN' : 'en-US', {
    currency: 'VND',
    maximumFractionDigits: 0,
    style: 'currency',
  }).format(value);
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
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [detail, setDetail] = useState<BatchDetail>();
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [success, setSuccess] = useState(false);
  const [batchReference, setBatchReference] = useState('');
  const [businessDate, setBusinessDate] = useState(today());
  const [environment, setEnvironment] = useState<'SANDBOX' | 'PRODUCTION'>('SANDBOX');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([newLine(1)]);

  const load = async (append = false, nextCursor: string | null = null): Promise<void> => {
    setBusy(true);
    setError(false);
    try {
      const query = new URLSearchParams({ limit: '20', store_id: store.id });
      if (status) query.set('status', status);
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

  useEffect(() => {
    void load();
  }, [store.id, status, dateFrom, dateTo]);

  const showDetail = async (batchId: string): Promise<void> => {
    setBusy(true);
    setError(false);
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
      const result = await request<BatchDetail>(
        `/v1/admin/financial-reconciliation/payment-batches?store_id=${encodeURIComponent(store.id)}`,
        {
          body: JSON.stringify({
            batch_reference: batchReference,
            business_date: businessDate,
            confirmation_code: 'IMPORT_PAYMENT_SETTLEMENT',
            provider_code: 'ZALO_CHECKOUT_ZALOPAY',
            provider_environment: environment,
            reason,
            records: lines.map((line) => ({
              fee_amount_vnd: Number(line.fee),
              gross_amount_vnd: Number(line.gross),
              occurred_at: new Date(line.occurredAt).toISOString(),
              provider_reference: line.providerReference,
              record_reference: line.recordReference,
              type: line.type,
            })),
          }),
          headers: {
            ...headers(),
            'Content-Type': 'application/json',
            'Idempotency-Key': `financial-reconciliation:${crypto.randomUUID()}`,
          },
          method: 'POST',
        },
      );
      setDetail(result);
      setSuccess(true);
      setImportOpen(false);
      setBatchReference('');
      setReason('');
      setConfirmed(false);
      setLines([newLine(1)]);
      await load();
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

      {detail && (
        <div className="reconciliation-detail">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{detail.batch_reference_masked}</p>
              <h3>{statusCopy[locale][detail.status]}</h3>
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
          </dl>
          <div className="reconciliation-lines">
            {detail.lines.map((line) => (
              <article key={line.id}>
                <div>
                  <strong>{line.type === 'PAYMENT' ? t.payment : t.refund}</strong>
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
              <p className="eyebrow">PAYMENT_PROVIDER</p>
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
                      onChange={(event) =>
                        updateLine(index, { type: event.target.value as LineType })
                      }
                      value={line.type}
                    >
                      <option value="PAYMENT">{t.payment}</option>
                      <option value="REFUND">{t.refund}</option>
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
                    {t.gross}
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
              onClick={() => setLines((current) => [...current, newLine(current.length + 1)])}
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
