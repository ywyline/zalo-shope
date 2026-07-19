import React, { useEffect, useMemo, useState } from 'react';
import { formatVnd, translate, type MessageKey } from '@zalo-shop/i18n';
import {
  Link,
  NavLink,
  Route,
  Routes,
  useLocation,
  useParams,
  useSearchParams,
} from 'react-router-dom';

import {
  catalogRequest,
  type Brand,
  type CatalogMedia,
  type Category,
  type CursorPage,
  type HomeModule,
  type HomePage,
  type HomeTarget,
  type Locale,
  type ProductDetail,
  type ProductSummary,
} from './catalog-api';
import { IdentityPanel } from './identity-panel';

type Loadable<T> = { data: T; status: 'ready' } | { status: 'error' } | { status: 'loading' };

function useCatalog<T>(path: string, locale: Locale): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    catalogRequest<T>(path, locale, controller.signal)
      .then((data) => setState({ data, status: 'ready' }))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setState({ status: 'error' });
        }
      });
    return () => controller.abort();
  }, [locale, path]);

  return state;
}

function text(locale: Locale, key: MessageKey): string {
  return translate(locale, key);
}

function MediaImage({
  className,
  eager = false,
  media,
  locale,
}: {
  className?: string;
  eager?: boolean;
  locale: Locale;
  media: CatalogMedia | null;
}): JSX.Element {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [media?.url]);
  if (!media || failed) {
    return (
      <div
        className={`media-placeholder ${className ?? ''}`}
        role="img"
        aria-label={text(locale, 'catalog.imageUnavailable')}
      >
        <span aria-hidden="true">✦</span>
        <small>{text(locale, 'catalog.imageUnavailable')}</small>
      </div>
    );
  }
  return (
    <img
      alt={media.alt_text}
      className={className}
      decoding="async"
      height={media.height ?? undefined}
      loading={eager ? 'eager' : 'lazy'}
      onError={() => setFailed(true)}
      src={media.url}
      width={media.width ?? undefined}
    />
  );
}

function StatePanel({
  locale,
  onRetry,
  status,
}: {
  locale: Locale;
  onRetry?: () => void;
  status: 'empty' | 'error' | 'loading';
}): JSX.Element {
  if (status === 'loading') {
    return (
      <div className="catalog-state loading" role="status">
        <span className="spinner" aria-hidden="true" />
        <strong>{text(locale, 'catalog.loading')}</strong>
        <span className="skeleton-line" />
      </div>
    );
  }
  return (
    <div className={`catalog-state ${status}`} role={status === 'error' ? 'alert' : 'status'}>
      <span className="state-glyph" aria-hidden="true">
        {status === 'error' ? '↻' : '◇'}
      </span>
      <strong>{text(locale, status === 'error' ? 'catalog.error' : 'catalog.empty')}</strong>
      {status === 'error' && onRetry && (
        <button className="button-quiet" onClick={onRetry} type="button">
          {text(locale, 'catalog.retry')}
        </button>
      )}
    </div>
  );
}

function Price({ product, locale }: { locale: Locale; product: ProductSummary }): JSX.Element {
  const { minimum, maximum } = product.price_range_vnd;
  return (
    <div className="price-row">
      <strong>
        {minimum !== maximum && <small>{text(locale, 'catalog.priceFrom')} </small>}
        {formatVnd(minimum, locale)}
      </strong>
      {product.market_price_range_vnd?.minimum &&
        product.market_price_range_vnd.minimum > minimum && (
          <del>{formatVnd(product.market_price_range_vnd.minimum, locale)}</del>
        )}
    </div>
  );
}

function ProductCard({
  locale,
  product,
}: {
  locale: Locale;
  product: ProductSummary;
}): JSX.Element {
  return (
    <Link className="product-card" to={`/products/${product.code}`}>
      <div className="product-image-wrap">
        <MediaImage className="product-image" locale={locale} media={product.primary_media} />
        <span className="brand-pill">{product.brand.name}</span>
      </div>
      <div className="product-copy">
        <p>{product.main_category.name}</p>
        <h3>{product.name}</h3>
        {product.selling_points && <small>{product.selling_points}</small>}
        <Price locale={locale} product={product} />
      </div>
    </Link>
  );
}

function BrandCard({ brand, locale }: { brand: Brand; locale: Locale }): JSX.Element {
  return (
    <Link className="brand-card" to={`/brands/${brand.code}`}>
      <MediaImage className="brand-logo" locale={locale} media={brand.logo} />
      <div>
        <h3>{brand.name}</h3>
        <p>{brand.introduction ?? text(locale, 'catalog.explore')}</p>
      </div>
      <span aria-hidden="true">→</span>
    </Link>
  );
}

function CategoryCard({ category, locale }: { category: Category; locale: Locale }): JSX.Element {
  return (
    <Link className="category-card" to={`/products?category=${category.code}`}>
      <MediaImage className="category-image" locale={locale} media={category.media} />
      <strong>{category.name}</strong>
      <span aria-hidden="true">↗</span>
    </Link>
  );
}

function targetHref(target: HomeTarget): string | undefined {
  if (!target) return undefined;
  if (target.type === 'EXTERNAL') return target.url;
  if (target.type === 'PRODUCT') return `/products/${target.code}`;
  if (target.type === 'BRAND') return `/brands/${target.code}`;
  if (target.type === 'CATEGORY') return `/products?category=${target.code}`;
  return '/';
}

function TargetLink({
  children,
  className,
  target,
}: {
  children: React.ReactNode;
  className: string;
  target: HomeTarget;
}): JSX.Element | null {
  const href = targetHref(target);
  if (!href) return null;
  if (target?.type === 'EXTERNAL') {
    return (
      <a className={className} href={href} rel="noreferrer" target="_blank">
        {children}
      </a>
    );
  }
  return (
    <Link className={className} to={href}>
      {children}
    </Link>
  );
}

function HomeSection({ locale, module }: { locale: Locale; module: HomeModule }): JSX.Element {
  if (module.module_type === 'HERO' || module.module_type === 'BANNER') {
    const color =
      typeof module.background_config.color === 'string' &&
      /^#[0-9a-f]{6}$/i.test(module.background_config.color)
        ? module.background_config.color
        : undefined;
    return (
      <section
        className={`home-hero ${module.module_type.toLowerCase()}`}
        style={color ? { backgroundColor: color } : undefined}
      >
        <MediaImage eager className="hero-image" locale={locale} media={module.media[0] ?? null} />
        <div className="hero-copy">
          {module.content_config.eyebrow && (
            <p className="section-kicker">{module.content_config.eyebrow}</p>
          )}
          <h1>{module.title}</h1>
          {module.summary && <p>{module.summary}</p>}
          <TargetLink className="button-primary hero-action" target={module.target}>
            {module.button_label ?? text(locale, 'catalog.explore')}
          </TargetLink>
        </div>
      </section>
    );
  }
  if (module.module_type === 'RICH_TEXT') {
    return (
      <section className="rich-module">
        <p className="section-kicker">{module.content_config.eyebrow}</p>
        <h2>{module.title}</h2>
        {module.summary && <p>{module.summary}</p>}
      </section>
    );
  }
  const title = module.title ?? text(locale, 'catalog.explore');
  return (
    <section className="catalog-section">
      <div className="section-heading">
        <div>
          <p className="section-kicker">{module.content_config.eyebrow ?? 'Zalo Shop'}</p>
          <h2>{title}</h2>
        </div>
        {module.module_type === 'PRODUCT_GRID' && (
          <Link to="/products">{text(locale, 'catalog.viewAll')} →</Link>
        )}
        {module.module_type === 'BRAND_GRID' && (
          <Link to="/brands">{text(locale, 'catalog.viewAll')} →</Link>
        )}
        {module.module_type === 'CATEGORY_GRID' && (
          <Link to="/categories">{text(locale, 'catalog.viewAll')} →</Link>
        )}
      </div>
      {module.items.length === 0 ? (
        <StatePanel locale={locale} status="empty" />
      ) : module.module_type === 'PRODUCT_GRID' ? (
        <div className="product-grid">
          {(module.items as ProductSummary[]).map((product) => (
            <ProductCard key={product.code} locale={locale} product={product} />
          ))}
        </div>
      ) : module.module_type === 'BRAND_GRID' ? (
        <div className="brand-grid">
          {(module.items as Brand[]).map((brand) => (
            <BrandCard brand={brand} key={brand.code} locale={locale} />
          ))}
        </div>
      ) : (
        <div className="category-grid">
          {(module.items as Category[]).map((category) => (
            <CategoryCard category={category} key={category.code} locale={locale} />
          ))}
        </div>
      )}
    </section>
  );
}

function HomeView({ home, locale }: { home: Loadable<HomePage>; locale: Locale }): JSX.Element {
  const location = useLocation();
  if (home.status === 'loading') return <StatePanel locale={locale} status="loading" />;
  if (home.status === 'error') {
    return (
      <StatePanel
        key={location.key}
        locale={locale}
        onRetry={() => window.location.reload()}
        status="error"
      />
    );
  }
  if (home.data.modules.length === 0) return <StatePanel locale={locale} status="empty" />;
  return (
    <div className="home-view">
      <Link className="browse-entry" to="/products">
        <span aria-hidden="true">⌕</span>
        <strong>{text(locale, 'catalog.browse')}</strong>
        <small>M3</small>
      </Link>
      {home.data.modules.map((module) => (
        <HomeSection key={module.id} locale={locale} module={module} />
      ))}
    </div>
  );
}

function PageIntro({
  intro,
  kicker,
  title,
}: {
  intro?: string;
  kicker: string;
  title: string;
}): JSX.Element {
  return (
    <header className="page-intro">
      <Link className="back-link" to="/" aria-label={title}>
        ←
      </Link>
      <p className="section-kicker">{kicker}</p>
      <h1>{title}</h1>
      {intro && <p>{intro}</p>}
    </header>
  );
}

function CategoriesView({ locale }: { locale: Locale }): JSX.Element {
  const state = useCatalog<Category[]>('categories', locale);
  return (
    <div className="page-view">
      <PageIntro
        intro={text(locale, 'catalog.categories.intro')}
        kicker="Discovery"
        title={text(locale, 'catalog.categories')}
      />
      {state.status !== 'ready' ? (
        <StatePanel locale={locale} status={state.status} />
      ) : state.data.length === 0 ? (
        <StatePanel locale={locale} status="empty" />
      ) : (
        <div className="category-tree">
          {state.data.map((root) => (
            <section key={root.code}>
              <div className="root-category">
                <MediaImage className="root-category-image" locale={locale} media={root.media} />
                <div>
                  <p className="section-kicker">{root.code}</p>
                  <h2>{root.name}</h2>
                  {root.description && <p>{root.description}</p>}
                </div>
              </div>
              <div className="child-categories">
                {root.children.map((child) => (
                  <CategoryCard category={child} key={child.code} locale={locale} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function BrandsView({ locale }: { locale: Locale }): JSX.Element {
  const state = useCatalog<CursorPage<Brand>>('brands?limit=100', locale);
  return (
    <div className="page-view">
      <PageIntro
        intro={text(locale, 'catalog.brands.intro')}
        kicker="Curated houses"
        title={text(locale, 'catalog.brands')}
      />
      {state.status !== 'ready' ? (
        <StatePanel locale={locale} status={state.status} />
      ) : state.data.items.length === 0 ? (
        <StatePanel locale={locale} status="empty" />
      ) : (
        <div className="brand-grid wide">
          {state.data.items.map((brand) => (
            <BrandCard brand={brand} key={brand.code} locale={locale} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProductList({
  brand,
  category,
  locale,
}: {
  brand?: string;
  category?: string;
  locale: Locale;
}): JSX.Element {
  const [search, setSearch] = useSearchParams();
  const sort = search.get('sort') ?? 'newest';
  const [items, setItems] = useState<ProductSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'error' | 'loading' | 'ready'>('loading');
  const filterKey = `${brand ?? ''}:${category ?? ''}:${sort}:${locale}`;

  const path = useMemo(() => {
    const query = new URLSearchParams({ limit: '20', sort });
    if (brand) query.set('brand_code', brand);
    if (category) query.set('category_code', category);
    return `products?${query.toString()}`;
  }, [brand, category, sort]);

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    setItems([]);
    catalogRequest<CursorPage<ProductSummary>>(path, locale, controller.signal)
      .then((data) => {
        setItems(data.items);
        setNextCursor(data.next_cursor);
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setStatus('error');
      });
    return () => controller.abort();
  }, [filterKey, path]);

  const loadMore = async (): Promise<void> => {
    if (!nextCursor || status === 'loading') return;
    setStatus('loading');
    try {
      const data = await catalogRequest<CursorPage<ProductSummary>>(
        `${path}&cursor=${encodeURIComponent(nextCursor)}`,
        locale,
      );
      setItems((current) => [...current, ...data.items]);
      setNextCursor(data.next_cursor);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  };

  return (
    <>
      <div className="list-toolbar">
        <div>
          {(brand || category) && <small>{text(locale, 'catalog.filters')}</small>}
          <strong>{brand ?? category ?? text(locale, 'catalog.allProducts')}</strong>
        </div>
        <label>
          <span className="sr-only">{text(locale, 'catalog.products')}</span>
          <select
            onChange={(event) => {
              const next = new URLSearchParams(search);
              next.set('sort', event.target.value);
              setSearch(next);
            }}
            value={sort}
          >
            <option value="newest">{text(locale, 'catalog.sort.newest')}</option>
            <option value="price_asc">{text(locale, 'catalog.sort.priceAsc')}</option>
            <option value="price_desc">{text(locale, 'catalog.sort.priceDesc')}</option>
          </select>
        </label>
      </div>
      {status === 'loading' && items.length === 0 ? (
        <StatePanel locale={locale} status="loading" />
      ) : status === 'error' && items.length === 0 ? (
        <StatePanel locale={locale} status="error" />
      ) : items.length === 0 ? (
        <StatePanel locale={locale} status="empty" />
      ) : (
        <>
          <div className="product-grid product-list-grid">
            {items.map((product) => (
              <ProductCard key={product.code} locale={locale} product={product} />
            ))}
          </div>
          {nextCursor && (
            <button
              className="button-quiet load-more"
              disabled={status === 'loading'}
              onClick={() => void loadMore()}
              type="button"
            >
              {status === 'loading'
                ? text(locale, 'catalog.loading')
                : text(locale, 'catalog.loadMore')}
            </button>
          )}
        </>
      )}
    </>
  );
}

function ProductsView({ locale }: { locale: Locale }): JSX.Element {
  const [search] = useSearchParams();
  const brand = search.get('brand') ?? undefined;
  const category = search.get('category') ?? undefined;
  return (
    <div className="page-view">
      <PageIntro kicker="Catalog" title={text(locale, 'catalog.products')} />
      <ProductList brand={brand} category={category} locale={locale} />
    </div>
  );
}

function BrandDetailView({ locale }: { locale: Locale }): JSX.Element {
  const { brandCode = '' } = useParams();
  const brand = useCatalog<Brand>(`brands/${encodeURIComponent(brandCode)}`, locale);
  return (
    <div className="page-view">
      {brand.status !== 'ready' ? (
        <StatePanel locale={locale} status={brand.status} />
      ) : (
        <>
          <header className="brand-detail">
            <Link className="back-link" to="/brands">
              ←
            </Link>
            <MediaImage className="brand-detail-logo" locale={locale} media={brand.data.logo} />
            <p className="section-kicker">{text(locale, 'catalog.brands')}</p>
            <h1>{brand.data.name}</h1>
            {brand.data.introduction && <p>{brand.data.introduction}</p>}
          </header>
          <ProductList brand={brand.data.code} locale={locale} />
        </>
      )}
    </div>
  );
}

function documentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(documentText).filter(Boolean).join('\n');
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.value === 'string') return record.value;
    if (record.content) return documentText(record.content);
  }
  return '';
}

function ProductDetailView({ locale }: { locale: Locale }): JSX.Element {
  const { productCode = '' } = useParams();
  const state = useCatalog<ProductDetail>(`products/${encodeURIComponent(productCode)}`, locale);
  const [selectedCode, setSelectedCode] = useState('');
  const product = state.status === 'ready' ? state.data : undefined;
  useEffect(() => {
    setSelectedCode(product?.skus[0]?.code ?? '');
  }, [product?.code, locale]);
  if (state.status !== 'ready') {
    return (
      <div className="page-view">
        <StatePanel locale={locale} status={state.status} />
      </div>
    );
  }
  const selected = state.data.skus.find(({ code }) => code === selectedCode) ?? state.data.skus[0];
  const description = documentText(state.data.description_document);
  return (
    <article className="product-detail page-view">
      <header className="detail-media">
        <Link className="back-link overlay" to="/products">
          ←
        </Link>
        <MediaImage
          eager
          className="detail-image"
          locale={locale}
          media={selected?.media ?? state.data.primary_media}
        />
        <div className="detail-thumbnails" aria-label={state.data.name}>
          {state.data.gallery.slice(0, 5).map((media) => (
            <MediaImage
              className="detail-thumbnail"
              key={media.url}
              locale={locale}
              media={media}
            />
          ))}
        </div>
      </header>
      <div className="detail-content">
        <Link className="brand-link" to={`/brands/${state.data.brand.code}`}>
          {state.data.brand.name} →
        </Link>
        <h1>{state.data.name}</h1>
        {state.data.subtitle && <p className="detail-subtitle">{state.data.subtitle}</p>}
        {selected && (
          <div className="detail-price">
            <strong>{formatVnd(selected.sale_price_vnd, locale)}</strong>
            {selected.market_price_vnd && selected.market_price_vnd > selected.sale_price_vnd && (
              <del>{formatVnd(selected.market_price_vnd, locale)}</del>
            )}
          </div>
        )}
        <section className="sku-section">
          <div className="detail-section-title">
            <h2>{text(locale, 'catalog.selectedSku')}</h2>
            <small>{selected?.code}</small>
          </div>
          <div
            className="sku-options"
            role="radiogroup"
            aria-label={text(locale, 'catalog.selectedSku')}
          >
            {state.data.skus.map((sku) => (
              <button
                aria-checked={selected?.code === sku.code}
                className={selected?.code === sku.code ? 'active' : ''}
                key={sku.code}
                onClick={() => setSelectedCode(sku.code)}
                role="radio"
                type="button"
              >
                {sku.option_values.map(({ option_label }) => option_label).join(' · ')}
              </button>
            ))}
          </div>
        </section>
        {description && (
          <section className="detail-section">
            <h2>{text(locale, 'catalog.description')}</h2>
            <p>{description}</p>
          </section>
        )}
        {state.data.usage_instructions && (
          <section className="detail-section">
            <h2>{text(locale, 'catalog.usage')}</h2>
            <p>{state.data.usage_instructions}</p>
          </section>
        )}
        {state.data.attributes.length > 0 && (
          <section className="detail-section">
            <h2>{text(locale, 'catalog.attributes')}</h2>
            <dl className="attribute-list">
              {state.data.attributes.map((attribute) => (
                <div key={`${attribute.code}-${String(attribute.value)}`}>
                  <dt>{attribute.label}</dt>
                  <dd>
                    {String(attribute.value ?? '—')}
                    {attribute.unit ? ` ${attribute.unit}` : ''}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </div>
      <div className="purchase-dock" role="status">
        <button disabled type="button">
          {text(locale, 'catalog.cart')} · M3
        </button>
        <button className="button-primary" disabled type="button">
          {text(locale, 'catalog.notAvailable')}
        </button>
        <small>{text(locale, 'catalog.m3Notice')}</small>
      </div>
    </article>
  );
}

function UnavailableView({ locale, title }: { locale: Locale; title: MessageKey }): JSX.Element {
  return (
    <div className="page-view unavailable-view">
      <span aria-hidden="true">◇</span>
      <p className="section-kicker">M3</p>
      <h1>{text(locale, title)}</h1>
      <p>{text(locale, 'catalog.m3Notice')}</p>
      <Link className="button-primary" to="/products">
        {text(locale, 'catalog.explore')}
      </Link>
    </div>
  );
}

function ScrollToTop(): null {
  const location = useLocation();
  useEffect(() => {
    window.scrollTo({ left: 0, top: 0, behavior: 'auto' });
  }, [location.pathname]);
  return null;
}

export function CatalogApp(): JSX.Element {
  const [locale, setLocale] = useState<Locale>('vi');
  const home = useCatalog<HomePage>('home', locale);

  useEffect(() => {
    const root = document.documentElement;
    const storefront = home.status === 'ready' ? home.data.store : undefined;
    root.dataset.industry = storefront?.industry.toLowerCase() ?? 'beauty';
    const colors = storefront?.theme?.color_tokens;
    const apply = (source: unknown, variable: string): void => {
      if (typeof source === 'string' && /^#[0-9a-f]{6}$/i.test(source))
        root.style.setProperty(variable, source);
      else root.style.removeProperty(variable);
    };
    apply(colors?.accent, '--store-accent');
    apply(colors?.background, '--store-background');
    apply(colors?.text, '--store-text');
  }, [home]);

  const storeName = home.status === 'ready' ? home.data.store.name : 'Zalo Shop';
  return (
    <div className="store-app">
      <ScrollToTop />
      <header className="store-header">
        <Link className="store-brand" to="/">
          <span aria-hidden="true">Z</span>
          <div>
            <strong>{storeName}</strong>
            <small>{text(locale, 'catalog.storefront')}</small>
          </div>
        </Link>
        <div className="locale-switch" role="group" aria-label={text(locale, 'catalog.language')}>
          {(['vi', 'zh', 'en'] as const).map((item) => (
            <button
              aria-pressed={locale === item}
              className={locale === item ? 'active' : ''}
              key={item}
              onClick={() => setLocale(item)}
              type="button"
            >
              {item.toUpperCase()}
            </button>
          ))}
        </div>
      </header>

      <main className="store-main">
        <Routes>
          <Route element={<HomeView home={home} locale={locale} />} path="/" />
          <Route element={<CategoriesView locale={locale} />} path="/categories" />
          <Route element={<BrandsView locale={locale} />} path="/brands" />
          <Route element={<BrandDetailView locale={locale} />} path="/brands/:brandCode" />
          <Route element={<ProductsView locale={locale} />} path="/products" />
          <Route element={<ProductDetailView locale={locale} />} path="/products/:productCode" />
          <Route element={<UnavailableView locale={locale} title="catalog.cart" />} path="/cart" />
          <Route
            element={<UnavailableView locale={locale} title="catalog.orders" />}
            path="/orders"
          />
          <Route
            element={
              <div className="page-view">
                <IdentityPanel locale={locale} />
              </div>
            }
            path="/profile"
          />
          <Route element={<HomeView home={home} locale={locale} />} path="*" />
        </Routes>
      </main>

      <nav className="bottom-nav" aria-label={text(locale, 'catalog.browse')}>
        {[
          ['/', '⌂', 'catalog.home'],
          ['/categories', '◫', 'catalog.categories'],
          ['/cart', '◇', 'catalog.cart'],
          ['/orders', '▤', 'catalog.orders'],
          ['/profile', '○', 'catalog.profile'],
        ].map(([to, icon, key]) => (
          <NavLink end={to === '/'} key={to} to={to!}>
            <span aria-hidden="true">{icon}</span>
            <small>{text(locale, key as MessageKey)}</small>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
