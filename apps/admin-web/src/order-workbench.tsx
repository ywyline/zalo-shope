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
type Payment = {
  amount_vnd: number;
  created_at: string;
  id: string;
  order_id: string;
  payment_number: string;
  provider_reference_masked: string | null;
  status: string;
  version: number;
};
type Refund = {
  amount_vnd: number;
  id: string;
  payment_id: string;
  public_number: string;
  reason: string;
  requested_at: string;
  status: string;
  updated_at: string;
  version: number;
};
type IntegrationJob = {
  attempt_count: number;
  created_at: string;
  id: string;
  last_error_code: string | null;
  next_attempt_at: string | null;
  operation: string;
  status: 'DEAD_LETTER' | 'PENDING' | 'PROCESSING' | 'RETRY_WAIT' | 'SUCCEEDED';
  version: number;
};
type FinancialOperation =
  | { kind: 'job-retry'; job: IntegrationJob }
  | { kind: 'payment-query'; payment: Payment }
  | { kind: 'refund-create'; availableVnd: number; payment: Payment }
  | { kind: 'refund-query'; refund: Refund };

const copy = {
  vi: {
    actions: 'Thao tác',
    availableRefund: 'Có thể hoàn',
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
    createRefund: 'Tạo hoàn tiền',
    createShipmentReason: 'Tạo vận đơn GHN cho đơn hàng đã sẵn sàng giao',
    delivery: 'Giao đến',
    empty: 'Chưa có đơn hàng trong phạm vi này.',
    error: 'Không thể tải hoặc cập nhật đơn hàng.',
    financeError: 'Không thể tải hoặc cập nhật thanh toán và hoàn tiền.',
    financePending: 'Yêu cầu tài chính đã được ghi nhận và đang chờ xử lý.',
    estimatedDelivery: 'Dự kiến giao',
    getQuote: 'Lấy báo giá GHN',
    inspection: 'Kiểm tra hàng',
    inspectionAllow: 'Cho xem hàng, không thử',
    inspectionNone: 'Không cho kiểm tra hàng',
    label: 'In nhãn A5',
    labelReady: 'Nhãn đã sẵn sàng trong 60 giây.',
    loading: 'Đang tải đơn hàng…',
    integrationJobs: 'Tác vụ tích hợp cần chú ý',
    jobEmpty: 'Không có tác vụ chờ thử lại hoặc dead-letter.',
    jobError: 'Không thể tải tác vụ tích hợp.',
    noShipment: 'Đơn hàng chưa có vận đơn.',
    note: 'Ghi chú vận hành',
    operationPending: 'Yêu cầu đã được ghi nhận và đang chờ xử lý.',
    operationStatus: 'Lệnh gần nhất',
    orders: 'Đơn hàng & giao vận',
    payment: 'Thanh toán & hoàn tiền',
    paymentEmpty: 'Đơn hàng chưa có lần thanh toán trực tuyến.',
    paymentNumber: 'Mã thanh toán',
    queryPayment: 'Đối soát thanh toán',
    queryRefund: 'Kiểm tra hoàn tiền',
    queryReason: 'Chủ động kiểm tra trạng thái có thẩm quyền từ nhà cung cấp',
    quote: 'Phí vận chuyển',
    quoteExpired: 'Báo giá đã hết hạn. Vui lòng lấy báo giá mới.',
    reason: 'Lý do thao tác',
    retry: 'Thử lại',
    retryJob: 'Thử lại dead-letter',
    retryJobReason: 'Thử lại tác vụ dead-letter sau khi nhân viên đã kiểm tra nguyên nhân',
    refundAmount: 'Số tiền hoàn (VND)',
    refundEmpty: 'Chưa có khoản hoàn tiền.',
    refundReason: 'Hoàn tiền đã được khách hàng và nhân viên vận hành xác nhận',
    refundStatus: 'Trạng thái hoàn tiền',
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
    availableRefund: '可退款',
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
    createRefund: '创建退款',
    createShipmentReason: '为已进入待发货状态的订单创建 GHN 运单',
    delivery: '配送地址',
    empty: '当前范围暂无订单。',
    error: '订单加载或更新失败。',
    financeError: '支付与退款数据加载或更新失败。',
    financePending: '财务请求已可靠记录，正在等待异步处理。',
    estimatedDelivery: '预计送达',
    getQuote: '获取 GHN 报价',
    inspection: '验货规则',
    inspectionAllow: '允许验货，不允许试用',
    inspectionNone: '不允许验货',
    label: '打印 A5 面单',
    labelReady: '面单访问已生成，60 秒内有效。',
    loading: '正在加载订单…',
    integrationJobs: '需关注的集成任务',
    jobEmpty: '当前没有等待重试或死信任务。',
    jobError: '集成任务加载失败。',
    noShipment: '该订单尚未创建运单。',
    note: '运营备注',
    operationPending: '请求已可靠记录，正在等待异步处理。',
    operationStatus: '最近命令',
    orders: '订单与物流',
    payment: '支付与退款',
    paymentEmpty: '该订单暂无线上支付尝试。',
    paymentNumber: '支付编号',
    queryPayment: '主动支付查单',
    queryRefund: '查询退款状态',
    queryReason: '由运营人员主动查询供应商权威状态',
    quote: '物流报价',
    quoteExpired: '报价已过期，请重新获取。',
    reason: '操作原因',
    retry: '重试',
    retryJob: '重试死信任务',
    retryJobReason: '运营人员复核失败原因后重试死信任务',
    refundAmount: '退款金额（VND）',
    refundEmpty: '暂无退款记录。',
    refundReason: '客户与运营人员已确认本次退款',
    refundStatus: '退款状态',
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
    availableRefund: 'Refundable',
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
    createRefund: 'Create refund',
    createShipmentReason: 'Create a GHN shipment for this fulfillment-ready order',
    delivery: 'Delivery',
    empty: 'No orders exist in this scope yet.',
    error: 'The order could not be loaded or updated.',
    financeError: 'Payments and refunds could not be loaded or updated.',
    financePending: 'The financial request was recorded and is awaiting processing.',
    estimatedDelivery: 'Estimated delivery',
    getQuote: 'Get GHN quote',
    inspection: 'Inspection policy',
    inspectionAllow: 'Allow inspection, no try-on',
    inspectionNone: 'No inspection',
    label: 'Print A5 label',
    labelReady: 'Label access is ready for 60 seconds.',
    loading: 'Loading orders…',
    integrationJobs: 'Integration jobs requiring attention',
    jobEmpty: 'There are no retrying or dead-letter jobs.',
    jobError: 'Integration jobs could not be loaded.',
    noShipment: 'No shipment has been created for this order.',
    note: 'Operations note',
    operationPending: 'The request was recorded and is awaiting asynchronous processing.',
    operationStatus: 'Latest command',
    orders: 'Orders & shipping',
    payment: 'Payments & refunds',
    paymentEmpty: 'This order has no online payment attempts.',
    paymentNumber: 'Payment number',
    queryPayment: 'Query payment',
    queryRefund: 'Query refund',
    queryReason: 'Actively query the authoritative provider status',
    quote: 'Shipping quote',
    quoteExpired: 'The quote has expired. Request a new one.',
    reason: 'Operation reason',
    retry: 'Retry',
    retryJob: 'Retry dead letter',
    retryJobReason: 'Retry the dead-letter job after an operator reviewed the failure',
    refundAmount: 'Refund amount (VND)',
    refundEmpty: 'There are no refunds yet.',
    refundReason: 'The customer and operator approved this refund',
    refundStatus: 'Refund status',
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

const financialStatusCopy: Record<Locale, Record<string, string>> = {
  vi: {
    CANCELLED: 'Đã hủy',
    CREATED: 'Đã tạo',
    DEAD_LETTER: 'Cần xử lý',
    EXPIRED: 'Đã hết hạn',
    FAILED: 'Thất bại',
    PENDING: 'Đang chờ',
    PROCESSING: 'Đang xử lý',
    PROVIDER_PENDING: 'Chờ nhà cung cấp',
    REQUESTED: 'Đã tiếp nhận',
    RETRY_WAIT: 'Chờ thử lại',
    REVIEW_REQUIRED: 'Cần kiểm tra',
    SUCCEEDED: 'Thành công',
  },
  zh: {
    CANCELLED: '已取消',
    CREATED: '已创建',
    DEAD_LETTER: '需人工处理',
    EXPIRED: '已过期',
    FAILED: '失败',
    PENDING: '等待中',
    PROCESSING: '处理中',
    PROVIDER_PENDING: '等待供应商',
    REQUESTED: '已受理',
    RETRY_WAIT: '等待重试',
    REVIEW_REQUIRED: '待人工复核',
    SUCCEEDED: '成功',
  },
  en: {
    CANCELLED: 'Cancelled',
    CREATED: 'Created',
    DEAD_LETTER: 'Needs attention',
    EXPIRED: 'Expired',
    FAILED: 'Failed',
    PENDING: 'Pending',
    PROCESSING: 'Processing',
    PROVIDER_PENDING: 'Provider pending',
    REQUESTED: 'Requested',
    RETRY_WAIT: 'Retry waiting',
    REVIEW_REQUIRED: 'Review required',
    SUCCEEDED: 'Succeeded',
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

function financialStatus(locale: Locale, value: string): string {
  return financialStatusCopy[locale][value] ?? value;
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
  const [payments, setPayments] = useState<Payment[]>([]);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [financeState, setFinanceState] = useState<'error' | 'loading' | 'ready'>('ready');
  const [financeBusy, setFinanceBusy] = useState(false);
  const [financeNotice, setFinanceNotice] = useState('');
  const [jobs, setJobs] = useState<IntegrationJob[]>([]);
  const [jobState, setJobState] = useState<'error' | 'loading' | 'ready'>('loading');
  const [financialOperation, setFinancialOperation] = useState<FinancialOperation>();
  const [financialReason, setFinancialReason] = useState('');
  const [financialConfirmation, setFinancialConfirmation] = useState('');
  const [refundAmount, setRefundAmount] = useState(0);
  const [financialOperationKey, setFinancialOperationKey] = useState('');

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

  const loadFinancials = async (orderId: string): Promise<void> => {
    setFinanceState('loading');
    try {
      const [paymentPage, refundPage] = await Promise.all([
        request<{ items: Payment[] }>(`/v1/admin/payments${query}&limit=100&order_id=${orderId}`, {
          headers: headers(),
        }),
        request<{ items: Refund[] }>(`/v1/admin/refunds${query}&limit=100&order_id=${orderId}`, {
          headers: headers(),
        }),
      ]);
      setPayments(paymentPage.items);
      setRefunds(refundPage.items);
      setFinanceState('ready');
    } catch {
      setPayments([]);
      setRefunds([]);
      setFinanceState('error');
    }
  };

  const loadJobs = async (): Promise<void> => {
    setJobState('loading');
    try {
      const [retrying, deadLetters] = await Promise.all([
        request<{ items: IntegrationJob[] }>(
          `/v1/admin/integration-jobs${query}&limit=100&status=RETRY_WAIT`,
          { headers: headers() },
        ),
        request<{ items: IntegrationJob[] }>(
          `/v1/admin/integration-jobs${query}&limit=100&status=DEAD_LETTER`,
          { headers: headers() },
        ),
      ]);
      setJobs(
        [...deadLetters.items, ...retrying.items].sort((left, right) =>
          right.created_at.localeCompare(left.created_at),
        ),
      );
      setJobState('ready');
    } catch {
      setJobs([]);
      setJobState('error');
    }
  };

  const refreshSelected = async (orderId: string): Promise<void> => {
    const detail = await request<OrderDetail>(`/v1/admin/orders/${orderId}${query}`, {
      headers: headers(),
    });
    setSelected(detail);
    setNote(detail.note ?? '');
    setTags(detail.tags?.join(', ') ?? '');
    await Promise.all([loadShipment(orderId), loadFinancials(orderId)]);
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
      await loadJobs();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    setSelected(undefined);
    setShipment(null);
    setPayments([]);
    setRefunds([]);
    setFinanceNotice('');
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

  const availableRefund = (payment: Payment): number =>
    Math.max(
      0,
      payment.amount_vnd -
        refunds
          .filter(
            (refund) =>
              refund.payment_id === payment.id &&
              ['REQUESTED', 'PROCESSING', 'SUCCEEDED', 'REVIEW_REQUIRED'].includes(refund.status),
          )
          .reduce((sum, refund) => sum + refund.amount_vnd, 0),
    );

  const openFinancialOperation = (next: FinancialOperation): void => {
    setFinancialOperation(next);
    setFinancialOperationKey(crypto.randomUUID());
    setFinancialConfirmation('');
    setRefundAmount(next.kind === 'refund-create' ? next.availableVnd : 0);
    setFinancialReason(
      next.kind === 'refund-create'
        ? t.refundReason
        : next.kind === 'job-retry'
          ? t.retryJobReason
          : t.queryReason,
    );
  };

  const submitFinancialOperation = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!financialOperation || financialReason.trim().length < 10) return;
    if (
      financialOperation.kind === 'refund-create' &&
      (financialConfirmation !== 'CREATE_REFUND' ||
        !Number.isSafeInteger(refundAmount) ||
        refundAmount <= 0 ||
        refundAmount > financialOperation.availableVnd)
    ) {
      return;
    }
    if (financialOperation.kind === 'job-retry' && financialConfirmation !== 'RETRY_DEAD_LETTER') {
      return;
    }
    setFinanceBusy(true);
    setFinanceState('loading');
    setFinanceNotice('');
    try {
      const operation = financialOperation;
      const path =
        operation.kind === 'refund-create'
          ? `/v1/admin/payments/${operation.payment.id}/refunds${query}`
          : operation.kind === 'payment-query'
            ? `/v1/admin/payments/${operation.payment.id}/query${query}`
            : operation.kind === 'refund-query'
              ? `/v1/admin/refunds/${operation.refund.id}/query${query}`
              : `/v1/admin/integration-jobs/${operation.job.id}/retry${query}`;
      const body =
        operation.kind === 'refund-create'
          ? {
              amount_vnd: refundAmount,
              confirmation_code: 'CREATE_REFUND',
              expected_payment_version: operation.payment.version,
              reason: financialReason.trim(),
            }
          : operation.kind === 'payment-query'
            ? {
                expected_version: operation.payment.version,
                reason: financialReason.trim(),
              }
            : operation.kind === 'refund-query'
              ? {
                  expected_version: operation.refund.version,
                  reason: financialReason.trim(),
                }
              : {
                  confirmation_code: 'RETRY_DEAD_LETTER',
                  expected_version: operation.job.version,
                  reason: financialReason.trim(),
                };
      await request(path, {
        body: JSON.stringify(body),
        headers: {
          ...headers(),
          'Content-Type': 'application/json',
          'Idempotency-Key': financialOperationKey,
        },
        method: 'POST',
      });
      setFinancialOperation(undefined);
      setFinanceNotice(t.financePending);
      await Promise.all([selected ? loadFinancials(selected.id) : Promise.resolve(), loadJobs()]);
    } catch {
      setFinanceState('error');
    } finally {
      setFinanceBusy(false);
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
          <p className="eyebrow">M5.7 · REFUNDS</p>
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

              <section className="admin-finance" aria-live="polite">
                <div className="admin-shipment-heading">
                  <div>
                    <p className="eyebrow">Zalo Checkout</p>
                    <h3>{t.payment}</h3>
                  </div>
                </div>
                {financeNotice && <p className="shipping-notice">{financeNotice}</p>}
                {financeState === 'loading' && <p className="shipping-state">{t.loading}</p>}
                {financeState === 'error' && (
                  <button
                    className="shipping-state error"
                    disabled={financeBusy}
                    onClick={() => void loadFinancials(selected.id)}
                    type="button"
                  >
                    {t.financeError} · {t.retry}
                  </button>
                )}
                {financeState === 'ready' && payments.length === 0 && (
                  <p className="finance-empty">{t.paymentEmpty}</p>
                )}
                {financeState === 'ready' && payments.length > 0 && (
                  <div className="payment-attempts">
                    {payments.map((payment) => {
                      const refundableVnd = availableRefund(payment);
                      const paymentRefunds = refunds.filter(
                        (refund) => refund.payment_id === payment.id,
                      );
                      return (
                        <article className="payment-attempt" key={payment.id}>
                          <header>
                            <div>
                              <small>{t.paymentNumber}</small>
                              <strong>{payment.payment_number}</strong>
                            </div>
                            <span
                              className={`finance-chip finance-${payment.status.toLowerCase()}`}
                            >
                              {financialStatus(locale, payment.status)}
                            </span>
                          </header>
                          <dl className="finance-facts">
                            <div>
                              <dt>{t.total}</dt>
                              <dd>{new Intl.NumberFormat('vi-VN').format(payment.amount_vnd)} ₫</dd>
                            </div>
                            <div>
                              <dt>{t.availableRefund}</dt>
                              <dd>{new Intl.NumberFormat('vi-VN').format(refundableVnd)} ₫</dd>
                            </div>
                          </dl>
                          <div className="finance-actions">
                            {payment.status === 'PROVIDER_PENDING' && (
                              <button
                                className="secondary"
                                disabled={financeBusy}
                                onClick={() =>
                                  openFinancialOperation({ kind: 'payment-query', payment })
                                }
                                type="button"
                              >
                                {t.queryPayment}
                              </button>
                            )}
                            {payment.status === 'SUCCEEDED' && refundableVnd > 0 && (
                              <button
                                className="primary"
                                disabled={financeBusy}
                                onClick={() =>
                                  openFinancialOperation({
                                    availableVnd: refundableVnd,
                                    kind: 'refund-create',
                                    payment,
                                  })
                                }
                                type="button"
                              >
                                {t.createRefund}
                              </button>
                            )}
                          </div>
                          {paymentRefunds.length === 0 ? (
                            <p className="finance-empty">{t.refundEmpty}</p>
                          ) : (
                            <div className="admin-refund-list">
                              {paymentRefunds.map((refund) => (
                                <div className="admin-refund-row" key={refund.id}>
                                  <div>
                                    <strong>{refund.public_number}</strong>
                                    <small>{dateTime(locale, refund.requested_at)}</small>
                                  </div>
                                  <strong>
                                    {new Intl.NumberFormat('vi-VN').format(refund.amount_vnd)} ₫
                                  </strong>
                                  <span
                                    className={`finance-chip finance-${refund.status.toLowerCase()}`}
                                  >
                                    {financialStatus(locale, refund.status)}
                                  </span>
                                  {refund.status === 'PROCESSING' && (
                                    <button
                                      className="secondary"
                                      disabled={financeBusy}
                                      onClick={() =>
                                        openFinancialOperation({ kind: 'refund-query', refund })
                                      }
                                      type="button"
                                    >
                                      {t.queryRefund}
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>

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

      <section className="integration-job-panel" aria-live="polite">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Outbox</p>
            <h3>{t.integrationJobs}</h3>
          </div>
          <button
            className="secondary"
            disabled={jobState === 'loading'}
            onClick={() => void loadJobs()}
            type="button"
          >
            {t.retry}
          </button>
        </div>
        {jobState === 'loading' && <p className="shipping-state">{t.loading}</p>}
        {jobState === 'error' && (
          <button className="shipping-state error" onClick={() => void loadJobs()} type="button">
            {t.jobError} · {t.retry}
          </button>
        )}
        {jobState === 'ready' && jobs.length === 0 && <p className="finance-empty">{t.jobEmpty}</p>}
        {jobState === 'ready' && jobs.length > 0 && (
          <div className="integration-job-list">
            {jobs.map((job) => (
              <article key={job.id}>
                <div>
                  <strong>{job.operation}</strong>
                  <small>{dateTime(locale, job.created_at)}</small>
                </div>
                <span className={`finance-chip finance-${job.status.toLowerCase()}`}>
                  {financialStatus(locale, job.status)}
                </span>
                <code>{job.last_error_code ?? '—'}</code>
                {job.status === 'DEAD_LETTER' && (
                  <button
                    className="secondary danger"
                    disabled={financeBusy}
                    onClick={() => openFinancialOperation({ job, kind: 'job-retry' })}
                    type="button"
                  >
                    {t.retryJob}
                  </button>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

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
      {financialOperation && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="confirm-modal shipment-operation-dialog"
            onSubmit={(event) => void submitFinancialOperation(event)}
          >
            <p className="eyebrow">Zalo Checkout · Outbox</p>
            <h2>
              {financialOperation.kind === 'refund-create'
                ? t.createRefund
                : financialOperation.kind === 'payment-query'
                  ? t.queryPayment
                  : financialOperation.kind === 'refund-query'
                    ? t.queryRefund
                    : t.retryJob}
            </h2>
            {financialOperation.kind === 'refund-create' && (
              <label>
                {t.refundAmount} · ≤{' '}
                {new Intl.NumberFormat('vi-VN').format(financialOperation.availableVnd)}
                <input
                  inputMode="numeric"
                  max={financialOperation.availableVnd}
                  min={1}
                  onChange={(event) => setRefundAmount(Number(event.target.value))}
                  required
                  step={1}
                  type="number"
                  value={refundAmount}
                />
              </label>
            )}
            <label>
              {t.reason}
              <textarea
                maxLength={500}
                minLength={10}
                onChange={(event) => setFinancialReason(event.target.value)}
                required
                rows={3}
                value={financialReason}
              />
            </label>
            {(financialOperation.kind === 'refund-create' ||
              financialOperation.kind === 'job-retry') && (
              <label>
                {t.confirmation} ·{' '}
                {financialOperation.kind === 'refund-create'
                  ? 'CREATE_REFUND'
                  : 'RETRY_DEAD_LETTER'}
                <input
                  autoComplete="off"
                  onChange={(event) => setFinancialConfirmation(event.target.value)}
                  pattern={
                    financialOperation.kind === 'refund-create'
                      ? 'CREATE_REFUND'
                      : 'RETRY_DEAD_LETTER'
                  }
                  required
                  value={financialConfirmation}
                />
              </label>
            )}
            <div>
              <button
                className="secondary"
                disabled={financeBusy}
                onClick={() => setFinancialOperation(undefined)}
                type="button"
              >
                {t.cancel}
              </button>
              <button className="primary" disabled={financeBusy} type="submit">
                {t.submit}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
