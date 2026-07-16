import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

function FoundationStatus(): JSX.Element {
  return (
    <main className="mini-shell">
      <section className="mini-card" aria-labelledby="mini-title">
        <div className="petal" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className="mini-eyebrow">Zalo Shop</p>
        <h1 id="mini-title">Nền tảng đang được chuẩn bị</h1>
        <p>
          Môi trường Mini App đã sẵn sàng. Danh mục và chức năng mua sắm chưa được phát hành trong
          giai đoạn kỹ thuật M0.
        </p>
        <div className="mini-status" role="status">
          <span aria-hidden="true" /> Hệ thống phát triển hoạt động
        </div>
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
