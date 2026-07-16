import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

function FoundationStatus(): JSX.Element {
  return (
    <main className="shell">
      <section className="status-card" aria-labelledby="page-title">
        <div className="brand-mark" aria-hidden="true">
          Z
        </div>
        <p className="eyebrow">Zalo Shop · Nền tảng quản trị</p>
        <h1 id="page-title">Nền tảng kỹ thuật đã sẵn sàng</h1>
        <p className="description">
          Giai đoạn M0 chỉ xác nhận môi trường phát triển. Chức năng quản trị cửa hàng sẽ được xây
          dựng sau khi mô hình phân quyền và cách ly dữ liệu được phê duyệt.
        </p>
        <dl className="status-grid">
          <div>
            <dt>Ngôn ngữ mặc định</dt>
            <dd>Tiếng Việt</dd>
          </div>
          <div>
            <dt>Tiền tệ</dt>
            <dd>VND</dd>
          </div>
          <div>
            <dt>Trạng thái</dt>
            <dd className="ready">
              <span aria-hidden="true" /> M0 sẵn sàng
            </dd>
          </div>
        </dl>
      </section>
    </main>
  );
}

const rootElement = document.querySelector('#root');
if (!rootElement) {
  throw new Error('Root element was not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <FoundationStatus />
  </StrictMode>,
);
