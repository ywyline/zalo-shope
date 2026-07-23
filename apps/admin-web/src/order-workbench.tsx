import React, { useEffect, useState } from 'react';

type Locale = 'en' | 'vi' | 'zh';
type Store = { code: string; default_locale: Locale; id: string };
type Request = <T>(path: string, options?: RequestInit) => Promise<T>;
type Order = {
  created_at: string;
  id: string;
  items: Array<{ payable_vnd: number; quantity: number; sku_code: string }>;
  order_number: string;
  payable_vnd: number;
  payment_method: string;
  payment_status: string;
  status: string;
  version?: number;
};
type OrderDetail = Order & {
  address: {
    detail: string;
    district_name: string | null;
    masked_phone: string;
    province_name: string | null;
    recipient_name: string;
    ward_name: string | null;
  } | null;
  cancellation_reason: string | null;
  note?: string | null;
  tags?: string[];
  transitions: Array<{ created_at: string; event: string; to_status: string }>;
};

const copy = {
  vi: {
    actions: 'Thao tác',
    cancel: 'Hủy đơn',
    cancelPrompt: 'Hủy đơn hàng này trước khi giao?',
    cancelReason: 'Nhân viên vận hành đã hủy đơn',
    close: 'Đóng đơn',
    closePrompt: 'Đóng đơn hàng này?',
    closeReason: 'Nhân viên vận hành đã đóng đơn',
    confirm: 'Xác nhận COD',
    confirmPrompt: 'Xác nhận đơn COD hợp lệ và trừ tồn kho đã giữ?',
    confirmReason: 'Nhân viên vận hành đã xác nhận COD',
    delivery: 'Giao đến',
    empty: 'Chưa có đơn hàng trong phạm vi này.',
    error: 'Không thể tải hoặc cập nhật đơn hàng.',
    loading: 'Đang tải đơn hàng…',
    note: 'Ghi chú vận hành',
    orders: 'Đơn hàng & COD',
    save: 'Lưu ghi chú',
    select: 'Chọn một đơn hàng để xem chi tiết.',
    status: 'Trạng thái',
    tags: 'Nhãn (phân tách bằng dấu phẩy)',
    total: 'Tổng',
  },
  zh: {
    actions: '操作',
    cancel: '取消订单',
    cancelPrompt: '确认在发货前取消此订单？',
    cancelReason: '运营人员取消订单',
    close: '关闭订单',
    closePrompt: '确认关闭此订单？',
    closeReason: '运营人员关闭订单',
    confirm: '确认 COD',
    confirmPrompt: '确认 COD 订单有效并扣减已锁库存？',
    confirmReason: '运营人员确认 COD',
    delivery: '配送地址',
    empty: '当前范围暂无订单。',
    error: '订单加载或更新失败。',
    loading: '正在加载订单…',
    note: '运营备注',
    orders: '订单与 COD',
    save: '保存备注',
    select: '选择订单查看详情。',
    status: '状态',
    tags: '标签（逗号分隔）',
    total: '应付',
  },
  en: {
    actions: 'Actions',
    cancel: 'Cancel order',
    cancelPrompt: 'Cancel this order before fulfillment?',
    cancelReason: 'Cancelled by operations',
    close: 'Close order',
    closePrompt: 'Close this order?',
    closeReason: 'Closed by operations',
    confirm: 'Confirm COD',
    confirmPrompt: 'Confirm this COD order and consume its reserved stock?',
    confirmReason: 'Confirmed by operations',
    delivery: 'Delivery',
    empty: 'No orders exist in this scope yet.',
    error: 'The order could not be loaded or updated.',
    loading: 'Loading orders…',
    note: 'Operations note',
    orders: 'Orders & COD',
    save: 'Save note',
    select: 'Select an order to inspect its facts.',
    status: 'Status',
    tags: 'Tags (comma-separated)',
    total: 'Total',
  },
} as const;

const statusCopy: Record<Locale, Record<string, string>> = {
  vi: {
    CANCELLED: 'Đã hủy',
    CLOSED: 'Đã đóng',
    COMPLETED: 'Hoàn tất',
    CONFIRMED: 'Đã xác nhận',
    DELIVERED: 'Đã nhận hàng',
    PENDING_CONFIRMATION: 'Chờ xác nhận',
    PENDING_FULFILLMENT: 'Chờ giao hàng',
    PENDING_PAYMENT: 'Chờ thanh toán',
    SHIPPED: 'Đang giao',
  },
  zh: {
    CANCELLED: '已取消',
    CLOSED: '已关闭',
    COMPLETED: '已完成',
    CONFIRMED: '已确认',
    DELIVERED: '已签收',
    PENDING_CONFIRMATION: '待确认',
    PENDING_FULFILLMENT: '待发货',
    PENDING_PAYMENT: '待支付',
    SHIPPED: '配送中',
  },
  en: {
    CANCELLED: 'Cancelled',
    CLOSED: 'Closed',
    COMPLETED: 'Completed',
    CONFIRMED: 'Confirmed',
    DELIVERED: 'Delivered',
    PENDING_CONFIRMATION: 'Pending confirmation',
    PENDING_FULFILLMENT: 'Pending fulfillment',
    PENDING_PAYMENT: 'Pending payment',
    SHIPPED: 'Shipped',
  },
};

const eventCopy: Record<Locale, Record<string, string>> = {
  vi: {
    CANCEL: 'Hủy đơn',
    CLOSE: 'Đóng đơn',
    CONFIRM_COD: 'Xác nhận COD',
    CREATE: 'Tạo đơn',
    FULFILLMENT_READY: 'Sẵn sàng giao hàng',
  },
  zh: {
    CANCEL: '取消订单',
    CLOSE: '关闭订单',
    CONFIRM_COD: '确认 COD',
    CREATE: '创建订单',
    FULFILLMENT_READY: '进入待发货',
  },
  en: {
    CANCEL: 'Cancelled',
    CLOSE: 'Closed',
    CONFIRM_COD: 'COD confirmed',
    CREATE: 'Created',
    FULFILLMENT_READY: 'Ready for fulfillment',
  },
};

export function OrderWorkbench({
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
  const query = `?store_id=${encodeURIComponent(store.id)}`;
  const [orders, setOrders] = useState<Order[]>([]);
  const [selected, setSelected] = useState<OrderDetail>();
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const load = async (): Promise<void> => {
    setBusy(true);
    setError(false);
    try {
      const page = await request<{ items: Order[] }>(`/v1/admin/orders${query}&limit=50`, {
        headers: headers(),
      });
      setOrders(page.items);
      if (selected)
        setSelected(
          await request<OrderDetail>(`/v1/admin/orders/${selected.id}${query}`, {
            headers: headers(),
          }),
        );
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    setSelected(undefined);
    void load();
  }, [store.id]);

  const inspect = async (order: Order): Promise<void> => {
    setBusy(true);
    try {
      const detail = await request<OrderDetail>(`/v1/admin/orders/${order.id}${query}`, {
        headers: headers(),
      });
      setSelected(detail);
      setNote(detail.note ?? '');
      setTags(detail.tags?.join(', ') ?? '');
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const action = async (
    path: string,
    body: Record<string, unknown>,
    confirmation: string,
  ): Promise<void> => {
    if (!selected || !window.confirm(confirmation)) return;
    setBusy(true);
    setError(false);
    try {
      await request(`/v1/admin/orders/${selected.id}/${path}${query}`, {
        body: JSON.stringify(body),
        headers: { ...headers(), 'Content-Type': 'application/json' },
        method: 'POST',
      });
      await load();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const saveNote = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    try {
      await request(`/v1/admin/orders/${selected.id}/notes${query}`, {
        body: JSON.stringify({
          note,
          tags: tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
        }),
        headers: { ...headers(), 'Content-Type': 'application/json' },
        method: 'PATCH',
      });
      await load();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="order-workbench">
      <div className="section-heading">
        <div>
          <p className="eyebrow">M4</p>
          <h2>{t.orders}</h2>
        </div>
        <button className="secondary" disabled={busy} onClick={() => void load()} type="button">
          {busy ? t.loading : '↻'}
        </button>
      </div>
      {error && <p className="dashboard-error">{t.error}</p>}
      <div className="order-workbench-grid">
        <div className="admin-order-list">
          {busy && orders.length === 0 ? <p className="empty-state">{t.loading}</p> : null}
          {!busy && orders.length === 0 ? <p className="empty-state">{t.empty}</p> : null}
          {orders.map((order) => (
            <button
              className={selected?.id === order.id ? 'admin-order-row active' : 'admin-order-row'}
              key={order.id}
              onClick={() => void inspect(order)}
              type="button"
            >
              <span>{order.order_number}</span>
              <small>{statusCopy[locale][order.status] ?? order.status}</small>
              <strong>{new Intl.NumberFormat('vi-VN').format(order.payable_vnd)} ₫</strong>
            </button>
          ))}
        </div>
        <div className="admin-order-detail">
          {!selected ? (
            <p className="empty-state">{t.select}</p>
          ) : (
            <>
              <div className="detail-heading">
                <div>
                  <p className="eyebrow">{selected.payment_method}</p>
                  <h3>{selected.order_number}</h3>
                </div>
                <span className="order-status">
                  {statusCopy[locale][selected.status] ?? selected.status}
                </span>
              </div>
              <dl className="order-facts">
                <div>
                  <dt>{t.status}</dt>
                  <dd>{statusCopy[locale][selected.status] ?? selected.status}</dd>
                </div>
                <div>
                  <dt>{t.total}</dt>
                  <dd>{new Intl.NumberFormat('vi-VN').format(selected.payable_vnd)} ₫</dd>
                </div>
                {selected.address && (
                  <div>
                    <dt>{t.delivery}</dt>
                    <dd>
                      {selected.address.recipient_name} · {selected.address.masked_phone}
                      <br />
                      {selected.address.detail}, {selected.address.ward_name},{' '}
                      {selected.address.district_name}, {selected.address.province_name}
                    </dd>
                  </div>
                )}
              </dl>
              <div className="admin-order-actions">
                {selected.status === 'PENDING_CONFIRMATION' && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void action('confirm-cod', { reason: t.confirmReason }, t.confirmPrompt)
                    }
                    type="button"
                  >
                    {t.confirm}
                  </button>
                )}
                {(selected.status === 'PENDING_CONFIRMATION' ||
                  selected.status === 'PENDING_FULFILLMENT') && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void action('cancel', { reason: t.cancelReason }, t.cancelPrompt)
                    }
                    type="button"
                  >
                    {t.cancel}
                  </button>
                )}
                {(selected.status === 'PENDING_CONFIRMATION' ||
                  selected.status === 'PENDING_PAYMENT') && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void action('close', { reason: t.closeReason }, t.closePrompt)}
                    type="button"
                  >
                    {t.close}
                  </button>
                )}
              </div>
              <label className="admin-note-field">
                {t.note}
                <textarea
                  maxLength={2000}
                  onChange={(event) => setNote(event.target.value)}
                  value={note}
                />
              </label>
              <label className="admin-note-field">
                {t.tags}
                <input
                  maxLength={1300}
                  onChange={(event) => setTags(event.target.value)}
                  value={tags}
                />
              </label>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void saveNote()}
                type="button"
              >
                {t.save}
              </button>
              <div className="admin-timeline">
                {selected.transitions.map((item) => (
                  <div key={`${item.created_at}-${item.event}`}>
                    <strong>{eventCopy[locale][item.event] ?? item.event}</strong>
                    <small>
                      {new Date(item.created_at).toLocaleString(
                        locale === 'vi' ? 'vi-VN' : locale === 'zh' ? 'zh-CN' : 'en-US',
                      )}
                    </small>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
