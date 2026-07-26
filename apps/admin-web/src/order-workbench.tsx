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
  version: number;
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
type ShippingQuote = {
  estimated_delivery_at: string | null;
  expires_at: string;
  id: string;
  service_code: string;
  source: string;
  total_fee_vnd: number;
};
type TrackingEvent = {
  location_masked: string | null;
  message_key: string;
  occurred_at: string;
  status: string;
};
type Shipment = {
  created_at: string;
  label_ready: boolean;
  latest_operation_status: string | null;
  provider_reference_masked: string | null;
  public_number: string;
  service_code: string;
  shipment_id: string;
  status: string;
  tracking_events: TrackingEvent[];
  updated_at: string;
  version: number;
};
type LabelAccess = { expires_at: string; url: string };
type ShipmentOperation = 'cancel' | 'create' | 'sync';

const copy = {
  vi: {
    actions: 'Thao tác',
    cancel: 'Hủy đơn',
    cancelPrompt: 'Hủy đơn hàng này trước khi giao?',
    cancelReason: 'Nhân viên vận hành đã hủy đơn',
    cancelShipment: 'Hủy vận đơn',
    cancelShipmentReason: 'Hủy vận đơn theo yêu cầu xử lý đơn hàng',
    close: 'Đóng đơn',
    closePrompt: 'Đóng đơn hàng này?',
    closeReason: 'Nhân viên vận hành đã đóng đơn',
    confirm: 'Xác nhận COD',
    confirmation: 'Nhập mã xác nhận',
    confirmPrompt: 'Xác nhận đơn COD hợp lệ và trừ tồn kho đã giữ?',
    confirmReason: 'Nhân viên vận hành đã xác nhận COD',
    createShipment: 'Tạo vận đơn',
    createShipmentReason: 'Tạo vận đơn GHN cho đơn hàng đã sẵn sàng giao',
    delivery: 'Giao đến',
    empty: 'Chưa có đơn hàng trong phạm vi này.',
    error: 'Không thể tải hoặc cập nhật đơn hàng.',
    estimatedDelivery: 'Dự kiến giao',
    getQuote: 'Lấy báo giá GHN',
    inspection: 'Kiểm tra hàng',
    inspectionAllow: 'Cho xem hàng, không thử',
    inspectionNone: 'Không cho kiểm tra hàng',
    label: 'In nhãn A5',
    labelReady: 'Nhãn đã sẵn sàng trong 60 giây.',
    loading: 'Đang tải đơn hàng…',
    noShipment: 'Đơn hàng chưa có vận đơn.',
    note: 'Ghi chú vận hành',
    operationPending: 'Yêu cầu đã được ghi nhận và đang chờ xử lý.',
    operationStatus: 'Lệnh gần nhất',
    orders: 'Đơn hàng & giao vận',
    quote: 'Phí vận chuyển',
    quoteExpired: 'Báo giá đã hết hạn. Vui lòng lấy báo giá mới.',
    reason: 'Lý do thao tác',
    retry: 'Thử lại',
    save: 'Lưu ghi chú',
    select: 'Chọn một đơn hàng để xem chi tiết.',
    serviceCode: 'Mã dịch vụ GHN',
    shipment: 'Vận đơn & hành trình',
    shipmentError: 'Không thể tải hoặc cập nhật vận đơn.',
    shipmentNumber: 'Mã vận đơn nội bộ',
    shipmentStatus: 'Trạng thái vận đơn',
    status: 'Trạng thái',
    submit: 'Xác nhận thao tác',
    syncShipment: 'Đồng bộ hành trình',
    syncShipmentReason: 'Chủ động đồng bộ trạng thái vận đơn từ GHN',
    tags: 'Nhãn (phân tách bằng dấu phẩy)',
    total: 'Tổng',
  },
  zh: {
    actions: '操作',
    cancel: '取消订单',
    cancelPrompt: '确认在发货前取消此订单？',
    cancelReason: '运营人员取消订单',
    cancelShipment: '取消运单',
    cancelShipmentReason: '根据订单履约处理要求取消运单',
    close: '关闭订单',
    closePrompt: '确认关闭此订单？',
    closeReason: '运营人员关闭订单',
    confirm: '确认 COD',
    confirmation: '输入确认码',
    confirmPrompt: '确认 COD 订单有效并扣减已锁库存？',
    confirmReason: '运营人员确认 COD',
    createShipment: '创建运单',
    createShipmentReason: '为已进入待发货状态的订单创建 GHN 运单',
    delivery: '配送地址',
    empty: '当前范围暂无订单。',
    error: '订单加载或更新失败。',
    estimatedDelivery: '预计送达',
    getQuote: '获取 GHN 报价',
    inspection: '验货规则',
    inspectionAllow: '允许验货，不允许试用',
    inspectionNone: '不允许验货',
    label: '打印 A5 面单',
    labelReady: '面单访问已生成，60 秒内有效。',
    loading: '正在加载订单…',
    noShipment: '该订单尚未创建运单。',
    note: '运营备注',
    operationPending: '请求已可靠记录，正在等待异步处理。',
    operationStatus: '最近命令',
    orders: '订单与物流',
    quote: '物流报价',
    quoteExpired: '报价已过期，请重新获取。',
    reason: '操作原因',
    retry: '重试',
    save: '保存备注',
    select: '选择订单查看详情。',
    serviceCode: 'GHN 服务编码',
    shipment: '运单与轨迹',
    shipmentError: '运单加载或更新失败。',
    shipmentNumber: '内部运单号',
    shipmentStatus: '运单状态',
    status: '状态',
    submit: '确认执行',
    syncShipment: '同步物流轨迹',
    syncShipmentReason: '从 GHN 主动同步当前运单权威状态',
    tags: '标签（逗号分隔）',
    total: '应付',
  },
  en: {
    actions: 'Actions',
    cancel: 'Cancel order',
    cancelPrompt: 'Cancel this order before fulfillment?',
    cancelReason: 'Cancelled by operations',
    cancelShipment: 'Cancel shipment',
    cancelShipmentReason: 'Cancel the shipment for order fulfillment handling',
    close: 'Close order',
    closePrompt: 'Close this order?',
    closeReason: 'Closed by operations',
    confirm: 'Confirm COD',
    confirmation: 'Enter confirmation code',
    confirmPrompt: 'Confirm this COD order and consume its reserved stock?',
    confirmReason: 'Confirmed by operations',
    createShipment: 'Create shipment',
    createShipmentReason: 'Create a GHN shipment for this fulfillment-ready order',
    delivery: 'Delivery',
    empty: 'No orders exist in this scope yet.',
    error: 'The order could not be loaded or updated.',
    estimatedDelivery: 'Estimated delivery',
    getQuote: 'Get GHN quote',
    inspection: 'Inspection policy',
    inspectionAllow: 'Allow inspection, no try-on',
    inspectionNone: 'No inspection',
    label: 'Print A5 label',
    labelReady: 'Label access is ready for 60 seconds.',
    loading: 'Loading orders…',
    noShipment: 'No shipment has been created for this order.',
    note: 'Operations note',
    operationPending: 'The request was recorded and is awaiting asynchronous processing.',
    operationStatus: 'Latest command',
    orders: 'Orders & shipping',
    quote: 'Shipping quote',
    quoteExpired: 'The quote has expired. Request a new one.',
    reason: 'Operation reason',
    retry: 'Retry',
    save: 'Save note',
    select: 'Select an order to inspect its facts.',
    serviceCode: 'GHN service code',
    shipment: 'Shipment & tracking',
    shipmentError: 'The shipment could not be loaded or updated.',
    shipmentNumber: 'Internal shipment number',
    shipmentStatus: 'Shipment status',
    status: 'Status',
    submit: 'Confirm action',
    syncShipment: 'Sync tracking',
    syncShipmentReason: 'Actively synchronize the authoritative shipment status from GHN',
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

const shipmentStatusCopy: Record<Locale, Record<string, string>> = {
  vi: {
    CANCELLED: 'Đã hủy vận đơn',
    CREATION_PENDING: 'Đang tạo vận đơn',
    DELIVERED: 'Đã giao hàng',
    EXCEPTION: 'Có sự cố',
    IN_TRANSIT: 'Đang vận chuyển',
    OUT_FOR_DELIVERY: 'Đang giao đến khách',
    PENDING_PICKUP: 'Chờ lấy hàng',
    REFUSED: 'Khách từ chối nhận',
    RETURNED: 'Đã hoàn hàng',
    RETURNING: 'Đang hoàn hàng',
    REVIEW_REQUIRED: 'Cần kiểm tra',
  },
  zh: {
    CANCELLED: '运单已取消',
    CREATION_PENDING: '正在创建运单',
    DELIVERED: '已签收',
    EXCEPTION: '物流异常',
    IN_TRANSIT: '运输中',
    OUT_FOR_DELIVERY: '派送中',
    PENDING_PICKUP: '待揽收',
    REFUSED: '已拒收',
    RETURNED: '已退回',
    RETURNING: '退回中',
    REVIEW_REQUIRED: '待人工复核',
  },
  en: {
    CANCELLED: 'Cancelled',
    CREATION_PENDING: 'Creation pending',
    DELIVERED: 'Delivered',
    EXCEPTION: 'Exception',
    IN_TRANSIT: 'In transit',
    OUT_FOR_DELIVERY: 'Out for delivery',
    PENDING_PICKUP: 'Pending pickup',
    REFUSED: 'Refused',
    RETURNED: 'Returned',
    RETURNING: 'Returning',
    REVIEW_REQUIRED: 'Review required',
  },
};

const trackingCopy: Record<Locale, Record<string, string>> = {
  vi: {
    'shipment.tracking.cancelled': 'Vận đơn đã được hủy.',
    'shipment.tracking.creation_pending': 'Đang gửi yêu cầu tạo vận đơn.',
    'shipment.tracking.delivered': 'Đơn hàng đã được giao thành công.',
    'shipment.tracking.exception': 'Đơn giao hàng cần nhân viên xử lý.',
    'shipment.tracking.in_transit': 'Đơn hàng đang được vận chuyển.',
    'shipment.tracking.out_for_delivery': 'Tài xế đang giao đơn hàng.',
    'shipment.tracking.pending_pickup': 'Đơn vị vận chuyển đang chờ lấy hàng.',
    'shipment.tracking.refused': 'Người nhận đã từ chối nhận hàng.',
    'shipment.tracking.returned': 'Đơn hàng đã được hoàn về kho.',
    'shipment.tracking.returning': 'Đơn hàng đang được hoàn về kho.',
    'shipment.tracking.review_required': 'Trạng thái đang được kiểm tra.',
  },
  zh: {
    'shipment.tracking.cancelled': '运单已取消。',
    'shipment.tracking.creation_pending': '运单创建请求已进入队列。',
    'shipment.tracking.delivered': '订单已成功签收。',
    'shipment.tracking.exception': '该物流单需要人工处理。',
    'shipment.tracking.in_transit': '订单正在运输中。',
    'shipment.tracking.out_for_delivery': '配送员正在派送。',
    'shipment.tracking.pending_pickup': '物流商正在等待揽收。',
    'shipment.tracking.refused': '收件人已拒收。',
    'shipment.tracking.returned': '订单已退回仓库。',
    'shipment.tracking.returning': '订单正在退回仓库。',
    'shipment.tracking.review_required': '物流状态正在人工复核。',
  },
  en: {
    'shipment.tracking.cancelled': 'The shipment was cancelled.',
    'shipment.tracking.creation_pending': 'The shipment creation request is queued.',
    'shipment.tracking.delivered': 'The order was delivered successfully.',
    'shipment.tracking.exception': 'The shipment needs operations attention.',
    'shipment.tracking.in_transit': 'The order is in transit.',
    'shipment.tracking.out_for_delivery': 'The courier is delivering the order.',
    'shipment.tracking.pending_pickup': 'The carrier is waiting to collect the order.',
    'shipment.tracking.refused': 'The recipient refused the order.',
    'shipment.tracking.returned': 'The order was returned to the warehouse.',
    'shipment.tracking.returning': 'The order is returning to the warehouse.',
    'shipment.tracking.review_required': 'The shipment status is under review.',
  },
};

const eventCopy: Record<Locale, Record<string, string>> = {
  vi: {
    CANCEL: 'Hủy đơn',
    CLOSE: 'Đóng đơn',
    CONFIRM_COD: 'Xác nhận COD',
    CREATE: 'Tạo đơn',
    DELIVER: 'Đã giao hàng',
    FULFILLMENT_READY: 'Sẵn sàng giao hàng',
    SHIP: 'Đã giao cho đơn vị vận chuyển',
  },
  zh: {
    CANCEL: '取消订单',
    CLOSE: '关闭订单',
    CONFIRM_COD: '确认 COD',
    CREATE: '创建订单',
    DELIVER: '订单已签收',
    FULFILLMENT_READY: '进入待发货',
    SHIP: '已交付物流商',
  },
  en: {
    CANCEL: 'Cancelled',
    CLOSE: 'Closed',
    CONFIRM_COD: 'COD confirmed',
    CREATE: 'Created',
    DELIVER: 'Delivered',
    FULFILLMENT_READY: 'Ready for fulfillment',
    SHIP: 'Handed to carrier',
  },
};

function dateTime(locale: Locale, value: string): string {
  return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : locale === 'zh' ? 'zh-CN' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function shipmentStatus(locale: Locale, value: string): string {
  return shipmentStatusCopy[locale][value] ?? shipmentStatusCopy[locale].REVIEW_REQUIRED!;
}

export function OrderWorkbench({
  apiUrl,
  headers,
  locale,
  request,
  store,
}: {
  apiUrl: (path: string) => string;
  headers: () => Record<string, string>;
  locale: Locale;
  request: Request;
  store: Store;
}): JSX.Element {
  const t = copy[locale];
  const query = `?store_id=${encodeURIComponent(store.id)}`;
  const [orders, setOrders] = useState<Order[]>([]);
  const [selected, setSelected] = useState<OrderDetail>();
  const [shipment, setShipment] = useState<Shipment | null>(null);
  const [shipmentState, setShipmentState] = useState<'error' | 'loading' | 'ready'>('ready');
  const [quote, setQuote] = useState<ShippingQuote>();
  const [serviceCode, setServiceCode] = useState('');
  const [inspectionPolicy, setInspectionPolicy] = useState<
    'ALLOW_INSPECTION_NO_TRY_ON' | 'NO_INSPECTION'
  >('NO_INSPECTION');
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [shippingBusy, setShippingBusy] = useState(false);
  const [error, setError] = useState(false);
  const [operation, setOperation] = useState<ShipmentOperation>();
  const [operationKey, setOperationKey] = useState('');
  const [operationReason, setOperationReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [notice, setNotice] = useState('');
  const [labelAccess, setLabelAccess] = useState<LabelAccess>();

  const loadShipment = async (orderId: string): Promise<void> => {
    setShipmentState('loading');
    try {
      const result = await request<{ shipment: Shipment | null }>(
        `/v1/admin/orders/${orderId}/shipment${query}`,
        { headers: headers() },
      );
      setShipment(result.shipment);
      setShipmentState('ready');
    } catch {
      setShipment(null);
      setShipmentState('error');
    }
  };

  const refreshSelected = async (orderId: string): Promise<void> => {
    const detail = await request<OrderDetail>(`/v1/admin/orders/${orderId}${query}`, {
      headers: headers(),
    });
    setSelected(detail);
    setNote(detail.note ?? '');
    setTags(detail.tags?.join(', ') ?? '');
    await loadShipment(orderId);
  };

  const load = async (): Promise<void> => {
    setBusy(true);
    setError(false);
    try {
      const page = await request<{ items: Order[] }>(`/v1/admin/orders${query}&limit=50`, {
        headers: headers(),
      });
      setOrders(page.items);
      if (selected) await refreshSelected(selected.id);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    setSelected(undefined);
    setShipment(null);
    void load();
  }, [store.id]);

  const inspect = async (order: Order): Promise<void> => {
    setBusy(true);
    setError(false);
    setQuote(undefined);
    setLabelAccess(undefined);
    setNotice('');
    try {
      await refreshSelected(order.id);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const action = async (
    path: string,
    body: Record<string, unknown>,
    prompt: string,
  ): Promise<void> => {
    if (!selected || !window.confirm(prompt)) return;
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
    setError(false);
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

  const requestQuote = async (): Promise<void> => {
    if (!selected) return;
    setShippingBusy(true);
    setShipmentState('ready');
    setNotice('');
    try {
      const result = await request<ShippingQuote>(`/v1/admin/shipping/quotes${query}`, {
        body: JSON.stringify({
          order_id: selected.id,
          ...(serviceCode.trim() ? { service_code: serviceCode.trim() } : {}),
        }),
        headers: { ...headers(), 'Content-Type': 'application/json' },
        method: 'POST',
      });
      setQuote(result);
      setServiceCode(result.service_code);
    } catch {
      setShipmentState('error');
    } finally {
      setShippingBusy(false);
    }
  };

  const openOperation = (next: ShipmentOperation): void => {
    setOperation(next);
    setOperationKey(crypto.randomUUID());
    setConfirmation('');
    setOperationReason(
      next === 'create'
        ? t.createShipmentReason
        : next === 'cancel'
          ? t.cancelShipmentReason
          : t.syncShipmentReason,
    );
  };

  const submitShipmentOperation = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!selected || !operation || operationReason.trim().length < 10) return;
    const expectedConfirmation =
      operation === 'create'
        ? 'CREATE_SHIPMENT'
        : operation === 'cancel'
          ? 'CANCEL_SHIPMENT'
          : 'SYNC_SHIPMENT';
    if (confirmation !== expectedConfirmation) return;
    if (operation === 'create' && (!quote || Date.parse(quote.expires_at) <= Date.now())) return;
    if (operation !== 'create' && !shipment) return;
    setShippingBusy(true);
    setShipmentState('loading');
    setNotice('');
    try {
      const path =
        operation === 'create'
          ? `/v1/admin/orders/${selected.id}/shipments${query}`
          : `/v1/admin/shipments/${shipment!.shipment_id}/${operation}${query}`;
      const body =
        operation === 'create'
          ? {
              confirmation_code: expectedConfirmation,
              expected_order_version: selected.version,
              inspection_policy: inspectionPolicy,
              reason: operationReason.trim(),
              service_code: quote!.service_code,
            }
          : {
              confirmation_code: expectedConfirmation,
              expected_version: shipment!.version,
              reason: operationReason.trim(),
            };
      await request(path, {
        body: JSON.stringify(body),
        headers: {
          ...headers(),
          'Content-Type': 'application/json',
          'Idempotency-Key': operationKey,
        },
        method: 'POST',
      });
      setOperation(undefined);
      setQuote(undefined);
      setLabelAccess(undefined);
      setNotice(t.operationPending);
      await refreshSelected(selected.id);
    } catch {
      setShipmentState('error');
    } finally {
      setShippingBusy(false);
    }
  };

  const issueLabel = async (): Promise<void> => {
    if (!shipment) return;
    setShippingBusy(true);
    setShipmentState('loading');
    try {
      const result = await request<LabelAccess>(
        `/v1/admin/shipments/${shipment.shipment_id}/label${query}&format=A5`,
        { headers: headers() },
      );
      setLabelAccess(result);
      setNotice(t.labelReady);
      setShipmentState('ready');
    } catch {
      setShipmentState('error');
    } finally {
      setShippingBusy(false);
    }
  };

  const quoteExpired = quote ? Date.parse(quote.expires_at) <= Date.now() : false;
  const operationConfirmation =
    operation === 'create'
      ? 'CREATE_SHIPMENT'
      : operation === 'cancel'
        ? 'CANCEL_SHIPMENT'
        : 'SYNC_SHIPMENT';

  return (
    <section className="order-workbench">
      <div className="section-heading">
        <div>
          <p className="eyebrow">M5.6 · GHN</p>
          <h2>{t.orders}</h2>
        </div>
        <button className="secondary" disabled={busy} onClick={() => void load()} type="button">
          {busy ? t.loading : t.retry}
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

              <section className="admin-shipment" aria-live="polite">
                <div className="admin-shipment-heading">
                  <div>
                    <p className="eyebrow">GHN</p>
                    <h3>{t.shipment}</h3>
                  </div>
                  {shipment && (
                    <span className={`shipment-chip shipment-${shipment.status.toLowerCase()}`}>
                      {shipmentStatus(locale, shipment.status)}
                    </span>
                  )}
                </div>
                {notice && <p className="shipping-notice">{notice}</p>}
                {shipmentState === 'loading' && <p className="shipping-state">{t.loading}</p>}
                {shipmentState === 'error' && (
                  <button
                    className="shipping-state error"
                    disabled={shippingBusy}
                    onClick={() => void loadShipment(selected.id)}
                    type="button"
                  >
                    {t.shipmentError} · {t.retry}
                  </button>
                )}
                {shipmentState === 'ready' && !shipment && (
                  <div className="shipping-create">
                    <p>{t.noShipment}</p>
                    {selected.status === 'PENDING_FULFILLMENT' && (
                      <>
                        <div className="shipping-quote-form">
                          <label>
                            {t.serviceCode}
                            <input
                              maxLength={64}
                              onChange={(event) => {
                                setServiceCode(event.target.value);
                                setQuote(undefined);
                              }}
                              value={serviceCode}
                            />
                          </label>
                          <button
                            className="secondary"
                            disabled={shippingBusy}
                            onClick={() => void requestQuote()}
                            type="button"
                          >
                            {t.getQuote}
                          </button>
                        </div>
                        {quote && (
                          <div
                            className={quoteExpired ? 'shipping-quote expired' : 'shipping-quote'}
                          >
                            <div>
                              <span>{t.quote}</span>
                              <strong>
                                {new Intl.NumberFormat('vi-VN').format(quote.total_fee_vnd)} ₫
                              </strong>
                            </div>
                            <div>
                              <span>{t.serviceCode}</span>
                              <strong>{quote.service_code}</strong>
                            </div>
                            {quote.estimated_delivery_at && (
                              <div>
                                <span>{t.estimatedDelivery}</span>
                                <strong>{dateTime(locale, quote.estimated_delivery_at)}</strong>
                              </div>
                            )}
                            {quoteExpired && <p>{t.quoteExpired}</p>}
                          </div>
                        )}
                        <label className="shipping-inspection">
                          {t.inspection}
                          <select
                            onChange={(event) =>
                              setInspectionPolicy(event.target.value as typeof inspectionPolicy)
                            }
                            value={inspectionPolicy}
                          >
                            <option value="NO_INSPECTION">{t.inspectionNone}</option>
                            <option value="ALLOW_INSPECTION_NO_TRY_ON">{t.inspectionAllow}</option>
                          </select>
                        </label>
                        <button
                          className="primary"
                          disabled={!quote || quoteExpired || shippingBusy}
                          onClick={() => openOperation('create')}
                          type="button"
                        >
                          {t.createShipment}
                        </button>
                      </>
                    )}
                  </div>
                )}
                {shipmentState === 'ready' && shipment && (
                  <>
                    <dl className="shipment-facts">
                      <div>
                        <dt>{t.shipmentNumber}</dt>
                        <dd>{shipment.public_number}</dd>
                      </div>
                      <div>
                        <dt>{t.shipmentStatus}</dt>
                        <dd>{shipmentStatus(locale, shipment.status)}</dd>
                      </div>
                      <div>
                        <dt>{t.serviceCode}</dt>
                        <dd>{shipment.service_code}</dd>
                      </div>
                      <div>
                        <dt>{t.operationStatus}</dt>
                        <dd>{shipment.latest_operation_status ?? '—'}</dd>
                      </div>
                    </dl>
                    <div className="shipment-actions">
                      <button
                        className="secondary"
                        disabled={shippingBusy}
                        onClick={() => openOperation('sync')}
                        type="button"
                      >
                        {t.syncShipment}
                      </button>
                      {(shipment.status === 'CREATION_PENDING' ||
                        shipment.status === 'PENDING_PICKUP') && (
                        <button
                          className="secondary danger"
                          disabled={shippingBusy}
                          onClick={() => openOperation('cancel')}
                          type="button"
                        >
                          {t.cancelShipment}
                        </button>
                      )}
                      {shipment.label_ready && !labelAccess && (
                        <button
                          className="secondary"
                          disabled={shippingBusy}
                          onClick={() => void issueLabel()}
                          type="button"
                        >
                          {t.label}
                        </button>
                      )}
                      {labelAccess && (
                        <a
                          className="secondary label-link"
                          href={apiUrl(labelAccess.url)}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {t.label}
                        </a>
                      )}
                    </div>
                    <div className="shipment-timeline">
                      {shipment.tracking_events.length === 0 ? (
                        <div>
                          <span />
                          <p>
                            <strong>{shipmentStatus(locale, shipment.status)}</strong>
                            <small>{dateTime(locale, shipment.updated_at)}</small>
                          </p>
                        </div>
                      ) : (
                        shipment.tracking_events.map((item, index) => (
                          <div
                            className={
                              index === shipment.tracking_events.length - 1 ? 'current' : ''
                            }
                            key={`${item.occurred_at}-${item.status}`}
                          >
                            <span />
                            <p>
                              <strong>
                                {trackingCopy[locale][item.message_key] ??
                                  shipmentStatus(locale, item.status)}
                              </strong>
                              {item.location_masked && <em>{item.location_masked}</em>}
                              <small>{dateTime(locale, item.occurred_at)}</small>
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                  </>
                )}
              </section>

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
                    <small>{dateTime(locale, item.created_at)}</small>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {operation && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="confirm-modal shipment-operation-dialog"
            onSubmit={(event) => void submitShipmentOperation(event)}
          >
            <p className="eyebrow">GHN</p>
            <h2>
              {operation === 'create'
                ? t.createShipment
                : operation === 'cancel'
                  ? t.cancelShipment
                  : t.syncShipment}
            </h2>
            <label>
              {t.reason}
              <textarea
                maxLength={500}
                minLength={10}
                onChange={(event) => setOperationReason(event.target.value)}
                required
                rows={3}
                value={operationReason}
              />
            </label>
            <label>
              {t.confirmation} · {operationConfirmation}
              <input
                autoComplete="off"
                onChange={(event) => setConfirmation(event.target.value)}
                pattern={operationConfirmation}
                required
                value={confirmation}
              />
            </label>
            <div>
              <button
                className="secondary"
                disabled={shippingBusy}
                onClick={() => setOperation(undefined)}
                type="button"
              >
                {t.cancel}
              </button>
              <button className="primary" disabled={shippingBusy} type="submit">
                {t.submit}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
