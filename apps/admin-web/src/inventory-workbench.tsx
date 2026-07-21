import { useEffect, useMemo, useState, type FormEvent } from 'react';

type Locale = 'en' | 'vi' | 'zh';
type Store = { code: string; default_locale: Locale; id: string };
type Request = <T>(path: string, options?: RequestInit) => Promise<T>;
type Page<T> = { items: T[]; next_cursor: string | null };
type Warehouse = {
  code: string;
  created_at: string;
  enabled: boolean;
  id: string;
  is_default_fulfillment: boolean;
  localizations: Array<{ locale: Locale; name: string }>;
  updated_at: string;
  version: number;
};
type Balance = {
  available: number;
  id: string;
  on_hand: number;
  reserved: number;
  sku_code: string;
  sku_id: string;
  updated_at: string;
  version: number;
  warehouse_id: string;
};
type Movement = {
  created_at: string;
  id: string;
  movement_type: string;
  note: string | null;
  on_hand_delta: number;
  reason_code: string;
  reserved_delta: number;
};
type ImportReport = {
  dry_run: boolean;
  error_count: number;
  operation_id: string | null;
  row_count: number;
  rows: Array<{ code: string | null; row: number; status: 'APPLIED' | 'ERROR' | 'VALID' }>;
  success_count: number;
};
type Section = 'import' | 'movements' | 'stock' | 'warehouses';

const copy = {
  vi: {
    adjust: 'Điều chỉnh',
    adjustHint: 'Nhập ADJUST để xác nhận thay đổi tồn kho có ghi nhật ký.',
    all: 'Tất cả trạng thái',
    apply: 'Áp dụng nhập kho',
    available: 'Có thể bán',
    cancel: 'Hủy',
    code: 'Mã kho',
    conflict: 'Dữ liệu đã thay đổi. Tải lại rồi thử lại.',
    create: 'Tạo kho',
    default: 'Kho mặc định',
    delta: 'Thay đổi',
    disabled: 'Đã tắt',
    empty: 'Không có dữ liệu phù hợp.',
    enabled: 'Đang hoạt động',
    error: 'Không thể tải hoặc lưu dữ liệu kho.',
    executeHint: 'Chỉ tệp không lỗi mới được áp dụng nguyên tử. Nhập IMPORT để xác nhận.',
    file: 'Tệp CSV / XLSX',
    import: 'Nhập tồn đầu kỳ',
    importColumns: 'Cột: warehouse_code, sku_code, quantity, note',
    inStock: 'Còn hàng',
    inventory: 'Kho & tồn kho',
    loading: 'Đang tải dữ liệu tồn kho…',
    low: 'Sắp hết (≤5)',
    makeDefault: 'Đặt mặc định',
    movements: 'Dòng biến động',
    nameEn: 'Tên tiếng Anh',
    nameVi: 'Tên tiếng Việt',
    nameZh: 'Tên tiếng Trung',
    newWarehouse: 'Kho mới',
    note: 'Ghi chú không chứa dữ liệu nhạy cảm',
    onHand: 'Tồn thực tế',
    out: 'Hết hàng',
    reason: 'Lý do',
    reserved: 'Đã giữ',
    retry: 'Thử lại',
    search: 'Tìm mã SKU…',
    stock: 'Số dư tồn kho',
    success: 'Thao tác tồn kho đã hoàn tất.',
    validate: 'Kiểm tra tệp',
    warehouses: 'Kho hàng',
  },
  zh: {
    adjust: '调整库存',
    adjustHint: '输入 ADJUST 确认这次受审库存变更。',
    all: '全部状态',
    apply: '执行导入',
    available: '可售',
    cancel: '取消',
    code: '仓库编码',
    conflict: '数据已经变化，请刷新后重试。',
    create: '创建仓库',
    default: '默认履约仓',
    delta: '调整差量',
    disabled: '已停用',
    empty: '没有符合条件的数据。',
    enabled: '启用',
    error: '库存数据加载或保存失败。',
    executeHint: '只有零错误文件才会原子执行；输入 IMPORT 二次确认。',
    file: 'CSV / XLSX 文件',
    import: '初始库存导入',
    importColumns: '列：warehouse_code、sku_code、quantity、note',
    inStock: '有库存',
    inventory: '仓库与库存',
    loading: '正在加载库存事实…',
    low: '低库存（≤5）',
    makeDefault: '设为默认',
    movements: '库存流水',
    nameEn: '英文名称',
    nameVi: '越南语名称',
    nameZh: '中文名称',
    newWarehouse: '新建仓库',
    note: '备注（不得包含敏感信息）',
    onHand: '实际库存',
    out: '零库存',
    reason: '原因',
    reserved: '锁定',
    retry: '重试',
    search: '搜索 SKU 编码…',
    stock: '库存余额',
    success: '库存操作已安全完成。',
    validate: '校验文件',
    warehouses: '仓库',
  },
  en: {
    adjust: 'Adjust stock',
    adjustHint: 'Type ADJUST to confirm this audited stock change.',
    all: 'All statuses',
    apply: 'Apply import',
    available: 'Available',
    cancel: 'Cancel',
    code: 'Warehouse code',
    conflict: 'The data changed. Reload before trying again.',
    create: 'Create warehouse',
    default: 'Default fulfillment',
    delta: 'Quantity delta',
    disabled: 'Disabled',
    empty: 'No matching inventory data.',
    enabled: 'Enabled',
    error: 'Inventory data could not be loaded or saved.',
    executeHint: 'Only an error-free file is applied atomically. Type IMPORT to confirm.',
    file: 'CSV / XLSX file',
    import: 'Initial stock import',
    importColumns: 'Columns: warehouse_code, sku_code, quantity, note',
    inStock: 'In stock',
    inventory: 'Warehouses & inventory',
    loading: 'Loading inventory facts…',
    low: 'Low stock (≤5)',
    makeDefault: 'Make default',
    movements: 'Stock movements',
    nameEn: 'English name',
    nameVi: 'Vietnamese name',
    nameZh: 'Chinese name',
    newWarehouse: 'New warehouse',
    note: 'Note without sensitive data',
    onHand: 'On hand',
    out: 'Out of stock',
    reason: 'Reason',
    reserved: 'Reserved',
    retry: 'Retry',
    search: 'Search SKU code…',
    stock: 'Inventory balances',
    success: 'Inventory operation completed safely.',
    validate: 'Validate file',
    warehouses: 'Warehouses',
  },
} as const;

function localizedName(warehouse: Warehouse | undefined, locale: Locale): string {
  if (!warehouse) return '—';
  return (
    warehouse.localizations.find((item) => item.locale === locale)?.name ??
    warehouse.localizations.find((item) => item.locale === 'vi')?.name ??
    warehouse.code
  );
}

function jsonHeaders(headers: () => Record<string, string>): Record<string, string> {
  return { ...headers(), 'Content-Type': 'application/json' };
}

function formText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

export function InventoryWorkbench({
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
  const [section, setSection] = useState<Section>('stock');
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [search, setSearch] = useState('');
  const [warehouseFilter, setWarehouseFilter] = useState('');
  const [stockFilter, setStockFilter] = useState<'all' | 'in' | 'out'>('all');
  const [creatingWarehouse, setCreatingWarehouse] = useState(false);
  const [adjusting, setAdjusting] = useState<Balance>();
  const [adjustmentKey, setAdjustmentKey] = useState(crypto.randomUUID());
  const [file, setFile] = useState<File>();
  const [importReport, setImportReport] = useState<ImportReport>();
  const [importKey, setImportKey] = useState(crypto.randomUUID());
  const [importConfirmation, setImportConfirmation] = useState('');

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const [warehousePage, balancePage, movementPage] = await Promise.all([
        request<Page<Warehouse>>(`/v1/admin/inventory/warehouses?${query}&limit=100`, {
          headers: headers(),
        }),
        request<Page<Balance>>(`/v1/admin/inventory/balances?${query}&limit=100`, {
          headers: headers(),
        }),
        request<Page<Movement>>(`/v1/admin/inventory/movements?${query}&limit=100`, {
          headers: headers(),
        }),
      ]);
      setWarehouses(warehousePage.items);
      setBalances(balancePage.items);
      setMovements(movementPage.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'INTERNAL_ERROR');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [store.id]);

  const filteredBalances = useMemo(
    () =>
      balances.filter(
        (balance) =>
          balance.sku_code.toLowerCase().includes(search.trim().toLowerCase()) &&
          (!warehouseFilter || balance.warehouse_id === warehouseFilter) &&
          (stockFilter === 'all' ||
            (stockFilter === 'in' ? balance.available > 0 : balance.available === 0)),
      ),
    [balances, search, stockFilter, warehouseFilter],
  );
  const outOfStock = balances.filter((item) => item.available === 0).length;
  const lowStock = balances.filter((item) => item.available > 0 && item.available <= 5).length;

  const createWarehouse = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const localizations = (['vi', 'zh', 'en'] as const).flatMap((language) => {
      const name = formText(form, `name_${language}`).trim();
      return name ? [{ locale: language, name }] : [];
    });
    setBusy(true);
    setError(undefined);
    try {
      await request(`/v1/admin/inventory/warehouses?${query}`, {
        body: JSON.stringify({
          code: formText(form, 'code'),
          enabled: true,
          is_default_fulfillment: form.get('default') === 'on',
          localizations,
        }),
        headers: jsonHeaders(headers),
        method: 'POST',
      });
      setCreatingWarehouse(false);
      setNotice(t.success);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'INTERNAL_ERROR');
    } finally {
      setBusy(false);
    }
  };

  const updateWarehouse = async (
    warehouse: Warehouse,
    patch: { enabled?: boolean; is_default_fulfillment?: boolean },
  ): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await request(`/v1/admin/inventory/warehouses/${warehouse.id}?${query}`, {
        body: JSON.stringify({ expected_version: warehouse.version, ...patch }),
        headers: jsonHeaders(headers),
        method: 'PATCH',
      });
      setNotice(t.success);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'INTERNAL_ERROR');
    } finally {
      setBusy(false);
    }
  };

  const submitAdjustment = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!adjusting) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      await request(`/v1/admin/inventory/adjustments?${query}`, {
        body: JSON.stringify({
          confirmation_code: formText(form, 'confirmation_code'),
          delta: Number(form.get('delta')),
          expected_version: adjusting.version,
          note: formText(form, 'note').trim() || null,
          reason_code: formText(form, 'reason_code') || 'CYCLE_COUNT',
          sku_id: adjusting.sku_id,
          warehouse_id: adjusting.warehouse_id,
        }),
        headers: { ...jsonHeaders(headers), 'Idempotency-Key': adjustmentKey },
        method: 'POST',
      });
      setAdjusting(undefined);
      setNotice(t.success);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'INTERNAL_ERROR');
    } finally {
      setBusy(false);
    }
  };

  const runImport = async (dryRun: boolean): Promise<void> => {
    if (!file) return;
    const body = new FormData();
    body.set('file', file);
    if (!dryRun) body.set('confirmation_code', importConfirmation);
    setBusy(true);
    setError(undefined);
    try {
      const report = await request<ImportReport>(
        `/v1/admin/inventory/imports?${query}&dry_run=${String(dryRun)}`,
        {
          body,
          headers: { ...headers(), 'Idempotency-Key': importKey },
          method: 'POST',
        },
      );
      setImportReport(report);
      if (!dryRun && report.error_count === 0) {
        setNotice(t.success);
        setImportKey(crypto.randomUUID());
        setImportConfirmation('');
        await load();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'INTERNAL_ERROR');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="inventory-workbench">
      <header className="inventory-heading">
        <div>
          <p className="eyebrow">M3 · Inventory facts</p>
          <h2>{t.inventory}</h2>
        </div>
        <button className="secondary" disabled={loading || busy} onClick={() => void load()}>
          {t.retry}
        </button>
      </header>

      <div className="inventory-metrics" aria-label="Inventory summary">
        <article>
          <span>{t.available}</span>
          <strong>{balances.reduce((sum, item) => sum + item.available, 0)}</strong>
        </article>
        <article className={lowStock ? 'warning' : ''}>
          <span>{t.low}</span>
          <strong>{lowStock}</strong>
        </article>
        <article className={outOfStock ? 'danger' : ''}>
          <span>{t.out}</span>
          <strong>{outOfStock}</strong>
        </article>
        <article>
          <span>{t.warehouses}</span>
          <strong>{warehouses.filter((item) => item.enabled).length}</strong>
        </article>
      </div>

      <nav className="inventory-tabs" aria-label={t.inventory}>
        {(
          [
            ['stock', t.stock],
            ['warehouses', t.warehouses],
            ['movements', t.movements],
            ['import', t.import],
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
          <span>{error === 'CONFLICT' ? t.conflict : t.error}</span>
          <button onClick={() => void load()}>{t.retry}</button>
        </div>
      )}
      {notice && (
        <div className="workbench-message success" role="status">
          <span>{notice}</span>
          <button onClick={() => setNotice(undefined)}>×</button>
        </div>
      )}

      {loading ? (
        <p className="inventory-state">{t.loading}</p>
      ) : section === 'stock' ? (
        <div className="inventory-panel">
          <div className="inventory-filters">
            <input
              aria-label={t.search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t.search}
              value={search}
            />
            <select
              aria-label={t.warehouses}
              onChange={(event) => setWarehouseFilter(event.target.value)}
              value={warehouseFilter}
            >
              <option value="">{t.warehouses}</option>
              {warehouses.map((warehouse) => (
                <option key={warehouse.id} value={warehouse.id}>
                  {localizedName(warehouse, locale)}
                </option>
              ))}
            </select>
            <select
              aria-label={t.all}
              onChange={(event) => setStockFilter(event.target.value as typeof stockFilter)}
              value={stockFilter}
            >
              <option value="all">{t.all}</option>
              <option value="in">{t.inStock}</option>
              <option value="out">{t.out}</option>
            </select>
          </div>
          {filteredBalances.length ? (
            <div className="inventory-table-wrap">
              <table className="inventory-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>{t.onHand}</th>
                    <th>{t.reserved}</th>
                    <th>{t.available}</th>
                    <th aria-label={t.adjust} />
                  </tr>
                </thead>
                <tbody>
                  {filteredBalances.map((balance) => (
                    <tr key={balance.id}>
                      <td>
                        <strong>{balance.sku_code}</strong>
                        <small>
                          {localizedName(
                            warehouses.find((item) => item.id === balance.warehouse_id),
                            locale,
                          )}
                        </small>
                      </td>
                      <td>{balance.on_hand}</td>
                      <td>{balance.reserved}</td>
                      <td>
                        <span
                          className={`stock-chip ${balance.available === 0 ? 'out' : balance.available <= 5 ? 'low' : ''}`}
                        >
                          {balance.available}
                        </span>
                      </td>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => {
                            setAdjustmentKey(crypto.randomUUID());
                            setAdjusting(balance);
                          }}
                        >
                          {t.adjust}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="inventory-state">{t.empty}</p>
          )}
        </div>
      ) : section === 'warehouses' ? (
        <div className="inventory-panel">
          <div className="inventory-panel-title">
            <h3>{t.warehouses}</h3>
            <button className="primary" onClick={() => setCreatingWarehouse(true)}>
              {t.newWarehouse}
            </button>
          </div>
          <div className="warehouse-grid">
            {warehouses.map((warehouse) => (
              <article key={warehouse.id}>
                <div>
                  <span className="warehouse-code">{warehouse.code}</span>
                  <h3>{localizedName(warehouse, locale)}</h3>
                  <p>{warehouse.enabled ? t.enabled : t.disabled}</p>
                </div>
                <div className="warehouse-actions">
                  {warehouse.is_default_fulfillment ? (
                    <span className="default-badge">{t.default}</span>
                  ) : warehouse.enabled ? (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void updateWarehouse(warehouse, { is_default_fulfillment: true })
                      }
                    >
                      {t.makeDefault}
                    </button>
                  ) : null}
                  {!warehouse.is_default_fulfillment && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        void updateWarehouse(warehouse, { enabled: !warehouse.enabled })
                      }
                    >
                      {warehouse.enabled ? t.disabled : t.enabled}
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : section === 'movements' ? (
        <div className="inventory-panel">
          {movements.length ? (
            <div className="movement-list">
              {movements.map((movement) => (
                <article key={movement.id}>
                  <span className={`movement-icon ${movement.on_hand_delta < 0 ? 'negative' : ''}`}>
                    {movement.on_hand_delta > 0 || movement.reserved_delta > 0 ? '↗' : '↘'}
                  </span>
                  <div>
                    <strong>{movement.movement_type}</strong>
                    <p>{movement.reason_code}</p>
                    {movement.note && <small>{movement.note}</small>}
                  </div>
                  <div className="movement-values">
                    <strong>
                      {movement.on_hand_delta > 0 ? '+' : ''}
                      {movement.on_hand_delta}
                    </strong>
                    <small>
                      {new Intl.DateTimeFormat(
                        locale === 'zh' ? 'zh-CN' : locale === 'en' ? 'en-US' : 'vi-VN',
                        { dateStyle: 'medium', timeStyle: 'short' },
                      ).format(new Date(movement.created_at))}
                    </small>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="inventory-state">{t.empty}</p>
          )}
        </div>
      ) : (
        <div className="inventory-panel import-panel">
          <div>
            <p className="eyebrow">Atomic initial load</p>
            <h3>{t.import}</h3>
            <p>{t.importColumns}</p>
          </div>
          <label className="inventory-file">
            <span>{t.file}</span>
            <input
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => {
                setFile(event.target.files?.[0]);
                setImportReport(undefined);
                setImportKey(crypto.randomUUID());
              }}
              type="file"
            />
          </label>
          <div className="import-confirmation">
            <p>{t.executeHint}</p>
            <input
              aria-label="IMPORT"
              onChange={(event) => setImportConfirmation(event.target.value)}
              placeholder="IMPORT"
              value={importConfirmation}
            />
            <div>
              <button
                className="secondary"
                disabled={!file || busy}
                onClick={() => void runImport(true)}
              >
                {t.validate}
              </button>
              <button
                className="primary"
                disabled={!file || busy || importConfirmation !== 'IMPORT'}
                onClick={() => void runImport(false)}
              >
                {t.apply}
              </button>
            </div>
          </div>
          {importReport && (
            <div className="inventory-import-report">
              <div>
                <strong>{importReport.success_count}</strong>
                <span>OK</span>
              </div>
              <div className={importReport.error_count ? 'failed' : ''}>
                <strong>{importReport.error_count}</strong>
                <span>ERROR</span>
              </div>
              <div className="inventory-import-rows">
                {importReport.rows.slice(0, 100).map((row) => (
                  <p key={row.row}>
                    <strong>#{row.row}</strong>
                    <span>{row.status}</span>
                    <small>{row.code ?? '—'}</small>
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {creatingWarehouse && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="confirm-modal inventory-dialog"
            onSubmit={(event) => void createWarehouse(event)}
          >
            <h2>{t.newWarehouse}</h2>
            <label>
              {t.code}
              <input name="code" pattern="[a-z][a-z0-9\-]{1,63}" required />
            </label>
            <label>
              {t.nameVi}
              <input name="name_vi" required />
            </label>
            <label>
              {t.nameZh}
              <input name="name_zh" />
            </label>
            <label>
              {t.nameEn}
              <input name="name_en" />
            </label>
            <label className="check-field">
              <input name="default" type="checkbox" /> {t.default}
            </label>
            <div>
              <button
                className="secondary"
                onClick={() => setCreatingWarehouse(false)}
                type="button"
              >
                {t.cancel}
              </button>
              <button className="primary" disabled={busy} type="submit">
                {t.create}
              </button>
            </div>
          </form>
        </div>
      )}

      {adjusting && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="confirm-modal inventory-dialog"
            onSubmit={(event) => void submitAdjustment(event)}
          >
            <p className="eyebrow">{adjusting.sku_code}</p>
            <h2>{t.adjust}</h2>
            <p>{t.adjustHint}</p>
            <label>
              {t.delta}
              <input name="delta" required step="1" type="number" />
            </label>
            <label>
              {t.reason}
              <select defaultValue="CYCLE_COUNT" name="reason_code">
                <option value="INITIAL_LOAD">INITIAL_LOAD</option>
                <option value="CYCLE_COUNT">CYCLE_COUNT</option>
                <option value="DAMAGED">DAMAGED</option>
                <option value="LOST">LOST</option>
                <option value="RETURN_CORRECTION">RETURN_CORRECTION</option>
                <option value="OTHER">OTHER</option>
              </select>
            </label>
            <label>
              {t.note}
              <textarea maxLength={500} name="note" rows={3} />
            </label>
            <label>
              ADJUST
              <input name="confirmation_code" pattern="ADJUST" required />
            </label>
            <div>
              <button className="secondary" onClick={() => setAdjusting(undefined)} type="button">
                {t.cancel}
              </button>
              <button className="primary" disabled={busy} type="submit">
                {t.adjust}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
