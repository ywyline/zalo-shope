import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';

import '@zalo-shop/design-tokens/theme.css';
import './styles.css';
import { CatalogApp } from './catalog-app';
import { MemberSessionProvider } from './member-session';

const rootElement = document.querySelector('#app');
if (!rootElement) throw new Error('Root element was not found');

createRoot(rootElement).render(
  <StrictMode>
    <HashRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
      <MemberSessionProvider>
        <CatalogApp />
      </MemberSessionProvider>
    </HashRouter>
  </StrictMode>,
);
