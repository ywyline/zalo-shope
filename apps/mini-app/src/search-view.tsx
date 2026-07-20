import React, { useEffect, useMemo, useRef, useState } from 'react';
import { formatVnd, translate, type MessageKey } from '@zalo-shop/i18n';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import type { Locale } from './catalog-api';
import { useMemberSession } from './member-session';
import {
  clearSearchHistory,
  searchFacets,
  searchHistory,
  searchProducts,
  searchSuggestions,
  type SearchFacets,
  type SearchProduct,
  type SearchSuggestion,
} from './search-api';

type FilterDraft = {
  attributes: string[];
  brands: string[];
  categories: string[];
  inStock: boolean;
  maxPrice: string;
  minPrice: string;
  onPromotion: boolean;
};

const EMPTY_FILTERS: FilterDraft = {
  attributes: [],
  brands: [],
  categories: [],
  inStock: false,
  maxPrice: '',
  minPrice: '',
  onPromotion: false,
};

function values(parameters: URLSearchParams, key: string): string[] {
  return parameters.getAll(key);
}

function draftFrom(parameters: URLSearchParams): FilterDraft {
  return {
    attributes: values(parameters, 'attribute_filters'),
    brands: values(parameters, 'brand_codes'),
    categories: values(parameters, 'category_codes'),
    inStock: parameters.get('in_stock') === 'true',
    maxPrice: parameters.get('max_price_vnd') ?? '',
    minPrice: parameters.get('min_price_vnd') ?? '',
    onPromotion: parameters.get('on_promotion') === 'true',
  };
}

function toggle(items: string[], value: string): string[] {
  return items.includes(value) ? items.filter((item) => item !== value) : [...items, value];
}

function activeFilterCount(parameters: URLSearchParams): number {
  return (
    values(parameters, 'attribute_filters').length +
    values(parameters, 'brand_codes').length +
    values(parameters, 'category_codes').length +
    ['min_price_vnd', 'max_price_vnd', 'in_stock', 'on_promotion'].filter((key) =>
      parameters.has(key),
    ).length
  );
}

function SearchCard({ locale, product }: { locale: Locale; product: SearchProduct }): JSX.Element {
  const t = (key: MessageKey): string => translate(locale, key);
  return (
    <Link className="search-product-card" to={`/products/${product.product_code}`}>
      <div className="search-product-media">
        {product.primary_media_url ? (
          <img alt={product.name} loading="lazy" src={product.primary_media_url} />
        ) : (
          <span aria-label={product.name}>◇</span>
        )}
        <small className={product.available ? 'available' : 'unavailable'}>
          {product.available ? t('search.available') : t('search.outOfStock')}
        </small>
      </div>
      <div className="search-product-copy">
        <p>{product.brand_code}</p>
        <h3>{product.name}</h3>
        <strong>{formatVnd(product.minimum_sale_price_vnd, locale)}</strong>
      </div>
    </Link>
  );
}

function ResultGrid({ items, locale }: { items: SearchProduct[]; locale: Locale }): JSX.Element {
  return (
    <div className="search-result-grid">
      {items.map((product) => (
        <SearchCard key={product.product_code} locale={locale} product={product} />
      ))}
    </div>
  );
}

export function SearchView({ locale }: { locale: Locale }): JSX.Element {
  const t = (key: MessageKey): string => translate(locale, key);
  const navigate = useNavigate();
  const session = useMemberSession();
  const [parameters, setParameters] = useSearchParams();
  const committedQuery = parameters.get('q') ?? '';
  const [input, setInput] = useState(committedQuery);
  const [items, setItems] = useState<SearchProduct[]>([]);
  const [recommendations, setRecommendations] = useState<SearchProduct[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<'error' | 'loading' | 'ready'>('loading');
  const [retryCount, setRetryCount] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [facets, setFacets] = useState<SearchFacets>();
  const [facetError, setFacetError] = useState(false);
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draft, setDraft] = useState<FilterDraft>(() => draftFrom(parameters));
  const filterHeading = useRef<HTMLHeadingElement>(null);
  const requestKey = `${parameters.toString()}:${locale}:${session.status}:${retryCount}`;
  const count = activeFilterCount(parameters);

  useEffect(() => setInput(committedQuery), [committedQuery]);

  useEffect(() => {
    const controller = new AbortController();
    setFacetError(false);
    searchFacets(locale, controller.signal)
      .then(setFacets)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setFacetError(true);
      });
    return () => controller.abort();
  }, [locale]);

  useEffect(() => {
    if (session.status === 'loading') return;
    const controller = new AbortController();
    const query = new URLSearchParams(parameters);
    query.delete('cursor');
    if (!query.has('limit')) query.set('limit', '20');
    setStatus('loading');
    setItems([]);
    setRecommendations([]);
    searchProducts(
      query,
      locale,
      session.status === 'ready' ? session.accessToken : undefined,
      controller.signal,
    )
      .then(async (page) => {
        setItems(page.items);
        setNextCursor(page.next_cursor);
        setStatus('ready');
        if (page.items.length === 0 && committedQuery) {
          const fallback = await searchProducts(
            new URLSearchParams({ limit: '4', sort: 'newest' }),
            locale,
            undefined,
            controller.signal,
          );
          setRecommendations(fallback.items);
        }
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setStatus('error');
      });
    return () => controller.abort();
  }, [requestKey]);

  useEffect(() => {
    if (session.status !== 'ready' || !session.accessToken) {
      setHistory([]);
      return;
    }
    searchHistory(locale, session.accessToken)
      .then((result) => setHistory(result.items.map(({ query }) => query)))
      .catch(() => setHistory([]));
  }, [committedQuery, locale, session.accessToken, session.status]);

  useEffect(() => {
    const query = input.trim();
    if (!query || query === committedQuery) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchSuggestions(query, locale, controller.signal)
        .then((result) => setSuggestions(result.items))
        .catch(() => setSuggestions([]));
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [committedQuery, input, locale]);

  useEffect(() => {
    if (filtersOpen) filterHeading.current?.focus();
  }, [filtersOpen]);

  const executeSearch = (query: string): void => {
    const next = new URLSearchParams(parameters);
    next.delete('cursor');
    const value = query.trim();
    if (value) next.set('q', value);
    else next.delete('q');
    setSuggestions([]);
    setParameters(next);
  };

  const loadMore = async (): Promise<void> => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const query = new URLSearchParams(parameters);
      query.set('limit', '20');
      query.set('cursor', nextCursor);
      const page = await searchProducts(
        query,
        locale,
        session.status === 'ready' ? session.accessToken : undefined,
      );
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch {
      setStatus('error');
    } finally {
      setLoadingMore(false);
    }
  };

  const applyFilters = (): void => {
    const next = new URLSearchParams(parameters);
    for (const key of [
      'attribute_filters',
      'brand_codes',
      'category_codes',
      'min_price_vnd',
      'max_price_vnd',
      'in_stock',
      'on_promotion',
      'cursor',
    ])
      next.delete(key);
    draft.attributes.forEach((value) => next.append('attribute_filters', value));
    draft.brands.forEach((value) => next.append('brand_codes', value));
    draft.categories.forEach((value) => next.append('category_codes', value));
    if (draft.minPrice) next.set('min_price_vnd', draft.minPrice);
    if (draft.maxPrice) next.set('max_price_vnd', draft.maxPrice);
    if (draft.inStock) next.set('in_stock', 'true');
    if (draft.onPromotion) next.set('on_promotion', 'true');
    setParameters(next);
    setFiltersOpen(false);
  };

  const sort = parameters.get('sort') ?? (committedQuery ? 'relevance' : 'newest');
  const historyContent = useMemo(() => [...new Set(history)].slice(0, 10), [history]);

  return (
    <div className="search-page page-view">
      <header className="search-header">
        <Link aria-label={t('catalog.back')} className="back-link" to="/">
          ←
        </Link>
        <p className="section-kicker">Discovery</p>
        <h1>{t('search.title')}</h1>
        <form
          className="search-form"
          onSubmit={(event) => {
            event.preventDefault();
            executeSearch(input);
          }}
          role="search"
        >
          <label className="sr-only" htmlFor="buyer-search">
            {t('search.placeholder')}
          </label>
          <input
            autoComplete="off"
            id="buyer-search"
            onChange={(event) => setInput(event.target.value)}
            placeholder={t('search.placeholder')}
            type="search"
            value={input}
          />
          <button aria-label={t('search.submit')} type="submit">
            ⌕
          </button>
          {suggestions.length > 0 && (
            <div className="search-suggestions" role="listbox" aria-label={t('search.suggestions')}>
              {suggestions.map((suggestion) => (
                <button
                  key={`${suggestion.kind}-${suggestion.product_code ?? suggestion.text}`}
                  onClick={() => {
                    if (suggestion.kind === 'PRODUCT' && suggestion.product_code) {
                      navigate(`/products/${suggestion.product_code}`);
                    } else {
                      setInput(suggestion.text);
                      executeSearch(suggestion.text);
                    }
                  }}
                  role="option"
                  type="button"
                >
                  <span aria-hidden="true">{suggestion.kind === 'PRODUCT' ? '◇' : '⌕'}</span>
                  {suggestion.text}
                </button>
              ))}
            </div>
          )}
        </form>
      </header>

      {!committedQuery && historyContent.length > 0 && (
        <section className="search-history" aria-labelledby="search-history-title">
          <div className="search-section-title">
            <h2 id="search-history-title">{t('search.history')}</h2>
            <button
              onClick={() => {
                if (!session.accessToken) return;
                void clearSearchHistory(locale, session.accessToken).then(() => setHistory([]));
              }}
              type="button"
            >
              {t('search.clearHistory')}
            </button>
          </div>
          <div className="history-chips">
            {historyContent.map((query) => (
              <button key={query} onClick={() => executeSearch(query)} type="button">
                {query}
              </button>
            ))}
          </div>
        </section>
      )}

      {!committedQuery && session.status !== 'ready' && (
        <p className="search-session-note">{t('search.loginHistory')}</p>
      )}

      <div className="search-toolbar">
        <div>
          <small>{t('search.results')}</small>
          <strong>{committedQuery || t('catalog.allProducts')}</strong>
        </div>
        <select
          aria-label={t('search.results')}
          onChange={(event) => {
            const next = new URLSearchParams(parameters);
            next.set('sort', event.target.value);
            next.delete('cursor');
            setParameters(next);
          }}
          value={sort}
        >
          <option value="relevance">{t('search.sort.relevance')}</option>
          <option value="newest">{t('search.sort.newest')}</option>
          <option value="price_asc">{t('search.sort.priceAsc')}</option>
          <option value="price_desc">{t('search.sort.priceDesc')}</option>
        </select>
        <button
          className="filter-trigger"
          onClick={() => {
            setDraft(draftFrom(parameters));
            setFiltersOpen(true);
          }}
          type="button"
        >
          {t('search.filters')}
          {count > 0 && <span>{count}</span>}
        </button>
      </div>

      {status === 'loading' ? (
        <div className="search-state" role="status">
          <span className="spinner" aria-hidden="true" />
          <strong>{t('search.loading')}</strong>
        </div>
      ) : status === 'error' ? (
        <div className="search-state error" role="alert">
          <span aria-hidden="true">!</span>
          <strong>{t('search.error')}</strong>
          <button onClick={() => setRetryCount((value) => value + 1)} type="button">
            {t('search.retry')}
          </button>
        </div>
      ) : items.length > 0 ? (
        <>
          <ResultGrid items={items} locale={locale} />
          {nextCursor && (
            <button
              className="button-quiet search-load-more"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              type="button"
            >
              {loadingMore ? t('search.loading') : t('search.loadMore')}
            </button>
          )}
        </>
      ) : (
        <div className="search-empty">
          <span aria-hidden="true">⌕</span>
          <h2>{t('search.noResults')}</h2>
          {recommendations.length > 0 && (
            <section>
              <h3>{t('search.recommendations')}</h3>
              <ResultGrid items={recommendations} locale={locale} />
            </section>
          )}
        </div>
      )}

      {filtersOpen && (
        <div className="filter-overlay" onMouseDown={() => setFiltersOpen(false)}>
          <section
            aria-labelledby="filter-title"
            aria-modal="true"
            className="filter-sheet"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header>
              <div>
                <p className="section-kicker">Refine</p>
                <h2 id="filter-title" ref={filterHeading} tabIndex={-1}>
                  {t('search.filters')}
                </h2>
              </div>
              <button
                aria-label={t('search.close')}
                onClick={() => setFiltersOpen(false)}
                type="button"
              >
                ×
              </button>
            </header>
            <div className="filter-sheet-body">
              {facetError && <p className="filter-error">{t('search.error')}</p>}
              {facets && (
                <>
                  <fieldset>
                    <legend>{t('search.brand')}</legend>
                    <div className="filter-options">
                      {facets.brands.map((brand) => (
                        <label key={brand.code}>
                          <input
                            checked={draft.brands.includes(brand.code)}
                            onChange={() =>
                              setDraft((current) => ({
                                ...current,
                                brands: toggle(current.brands, brand.code),
                              }))
                            }
                            type="checkbox"
                          />
                          <span>{brand.name}</span>
                          <small>{brand.count}</small>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend>{t('search.category')}</legend>
                    <div className="filter-options">
                      {facets.categories.map((category) => (
                        <label className={category.depth === 2 ? 'nested' : ''} key={category.code}>
                          <input
                            checked={draft.categories.includes(category.code)}
                            onChange={() =>
                              setDraft((current) => ({
                                ...current,
                                categories: toggle(current.categories, category.code),
                              }))
                            }
                            type="checkbox"
                          />
                          <span>{category.name}</span>
                          <small>{category.count}</small>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  {facets.attributes.map((attribute) => (
                    <fieldset key={attribute.code}>
                      <legend>{attribute.label}</legend>
                      <div className="filter-options compact">
                        {attribute.options.map((option) => {
                          const value = `${attribute.code}:${option.code}`;
                          return (
                            <label key={value}>
                              <input
                                checked={draft.attributes.includes(value)}
                                onChange={() =>
                                  setDraft((current) => ({
                                    ...current,
                                    attributes: toggle(current.attributes, value),
                                  }))
                                }
                                type="checkbox"
                              />
                              <span>{option.label}</span>
                              <small>{option.count}</small>
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>
                  ))}
                  <fieldset>
                    <legend>{t('search.price')}</legend>
                    <div className="price-filter">
                      <label>
                        {t('search.minPrice')}
                        <input
                          inputMode="numeric"
                          min="0"
                          onChange={(event) =>
                            setDraft((current) => ({ ...current, minPrice: event.target.value }))
                          }
                          placeholder={String(facets.price_range_vnd?.minimum ?? 0)}
                          step="1000"
                          type="number"
                          value={draft.minPrice}
                        />
                      </label>
                      <label>
                        {t('search.maxPrice')}
                        <input
                          inputMode="numeric"
                          min="0"
                          onChange={(event) =>
                            setDraft((current) => ({ ...current, maxPrice: event.target.value }))
                          }
                          placeholder={String(facets.price_range_vnd?.maximum ?? 0)}
                          step="1000"
                          type="number"
                          value={draft.maxPrice}
                        />
                      </label>
                    </div>
                  </fieldset>
                </>
              )}
              <fieldset>
                <legend>{t('search.filters')}</legend>
                <div className="filter-toggles">
                  <label>
                    <input
                      checked={draft.inStock}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, inStock: event.target.checked }))
                      }
                      type="checkbox"
                    />
                    {t('search.inStock')}
                  </label>
                </div>
              </fieldset>
            </div>
            <footer>
              <button
                className="button-quiet"
                onClick={() => setDraft(EMPTY_FILTERS)}
                type="button"
              >
                {t('search.reset')}
              </button>
              <button className="button-primary" onClick={applyFilters} type="button">
                {t('search.apply')}
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
