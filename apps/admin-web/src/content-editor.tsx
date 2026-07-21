import { useEffect, useMemo, useState } from 'react';

export type ContentLocale = 'en' | 'vi' | 'zh';
export type ContentStore = { code: string; id: string };

type Localization = {
  button_label: null | string;
  content_config: Record<string, unknown>;
  locale: ContentLocale;
  summary: null | string;
  title: string;
};
type PageModule = {
  background_config: { color: null | string; overlay: null | number };
  id?: string;
  localizations: Localization[];
  media: Array<{ media_id: string; purpose: 'COVER' | 'GALLERY'; sort_order: number }>;
  module_type: 'BANNER' | 'BRAND_GRID' | 'CATEGORY_GRID' | 'HERO' | 'PRODUCT_GRID' | 'RICH_TEXT';
  sort_order: number;
  status: 'ACTIVE' | 'DISABLED';
  target_id: null | string;
  target_type: 'BRAND' | 'CATEGORY' | 'EXTERNAL' | 'PAGE' | 'PRODUCT' | null;
  target_url: null | string;
  visible_from: null | string;
  visible_to: null | string;
};
type PageVersion = { modules: PageModule[]; publication_status: string; version: number };
type Page = {
  code: string;
  draft: null | PageVersion;
  id: string;
  published: null | PageVersion;
  status: string;
  version: number;
};

type Props = {
  headers: () => Record<string, string>;
  locale: ContentLocale;
  request: <T>(path: string, options?: RequestInit) => Promise<T>;
  store: ContentStore;
};

const copy = {
  vi: {
    add: 'Thêm mô-đun',
    create: 'Tạo trang',
    createHint: 'Bắt đầu với mã ổn định, ví dụ home.',
    denied: 'Bạn không có quyền đọc nội dung của cửa hàng này.',
    empty: 'Chưa có trang nội dung trong cửa hàng này.',
    error: 'Không thể tải nội dung.',
    external: 'Liên kết ngoài phải thuộc danh sách máy chủ được phép.',
    from: 'Hiện từ',
    loading: 'Đang tải nội dung…',
    module: 'Mô-đun',
    newPage: 'Trang mới',
    noTarget: 'Không liên kết',
    pageCode: 'Mã trang',
    preview: 'Xem trước theo chủ đề',
    publish: 'Xuất bản',
    publishBody: 'Phiên bản đang hiển thị sẽ thay đổi ngay. Nhập mã trang để xác nhận.',
    publishTitle: 'Xác nhận xuất bản',
    retry: 'Thử lại',
    save: 'Lưu bản nháp',
    saved: 'Đã lưu bản nháp.',
    summary: 'Mô tả',
    title: 'Tiêu đề',
    to: 'Ẩn sau',
    conflict: 'Nội dung đã thay đổi ở nơi khác. Hãy tải lại trước khi lưu.',
  },
  zh: {
    add: '添加模块',
    create: '创建页面',
    createHint: '先设置稳定页面编码，例如 home。',
    denied: '你没有当前商城的内容读取权限。',
    empty: '当前商城还没有内容页面。',
    error: '内容加载失败。',
    external: '外部链接主机必须在服务端白名单内。',
    from: '开始展示',
    loading: '正在加载内容…',
    module: '页面模块',
    newPage: '新页面',
    noTarget: '无跳转',
    pageCode: '页面编码',
    preview: '主题实时预览',
    publish: '发布',
    publishBody: '发布后线上展示版本会立即变化。请输入页面编码确认。',
    publishTitle: '确认发布',
    retry: '重新加载',
    save: '保存草稿',
    saved: '草稿已保存。',
    summary: '摘要',
    title: '标题',
    to: '结束展示',
    conflict: '内容已被其他会话修改，请重新加载后再保存。',
  },
  en: {
    add: 'Add module',
    create: 'Create page',
    createHint: 'Start with a stable page code, such as home.',
    denied: 'You do not have content access for this store.',
    empty: 'This store has no content pages yet.',
    error: 'Content could not be loaded.',
    external: 'External links must use a server-approved host.',
    from: 'Visible from',
    loading: 'Loading content…',
    module: 'Page module',
    newPage: 'New page',
    noTarget: 'No target',
    pageCode: 'Page code',
    preview: 'Live theme preview',
    publish: 'Publish',
    publishBody: 'Publishing changes the live version immediately. Enter the page code to confirm.',
    publishTitle: 'Confirm publication',
    retry: 'Reload',
    save: 'Save draft',
    saved: 'Draft saved.',
    summary: 'Summary',
    title: 'Title',
    to: 'Visible until',
    conflict: 'Content changed in another session. Reload before saving.',
  },
} as const;

const moduleTypes = [
  'HERO',
  'BANNER',
  'PRODUCT_GRID',
  'BRAND_GRID',
  'CATEGORY_GRID',
  'RICH_TEXT',
] as const;
const targetTypes = ['PRODUCT', 'BRAND', 'CATEGORY', 'PAGE', 'EXTERNAL'] as const;

function blankModule(index: number): PageModule {
  return {
    background_config: { color: '#f7e9ee', overlay: 0 },
    localizations: (['vi', 'zh', 'en'] as const).map((locale) => ({
      button_label: null,
      content_config: {},
      locale,
      summary: null,
      title: locale === 'vi' ? 'Nội dung mới' : locale === 'zh' ? '新内容' : 'New content',
    })),
    media: [],
    module_type: 'HERO',
    sort_order: index,
    status: 'ACTIVE',
    target_id: null,
    target_type: null,
    target_url: null,
    visible_from: null,
    visible_to: null,
  };
}

function normalizeModules(page?: Page): PageModule[] {
  return (page?.draft?.modules ?? page?.published?.modules ?? []).map((module, index) => ({
    ...module,
    background_config: {
      color: module.background_config.color ?? '#f7e9ee',
      overlay: module.background_config.overlay ?? 0,
    },
    sort_order: index,
  }));
}

function localInput(value: null | string): string {
  return value ? value.slice(0, 16) : '';
}

function apiDate(value: null | string): null | string {
  return value ? new Date(value).toISOString() : null;
}

export function ContentEditor({ headers, locale, request, store }: Props): JSX.Element {
  const t = copy[locale];
  const [pages, setPages] = useState<Page[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [modules, setModules] = useState<PageModule[]>([]);
  const [editingLocale, setEditingLocale] = useState<ContentLocale>(locale);
  const [pageCode, setPageCode] = useState('home');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [creatingPage, setCreatingPage] = useState(false);
  const [dragged, setDragged] = useState<number>();
  const selected = useMemo(() => pages.find(({ id }) => id === selectedId), [pages, selectedId]);

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await request<{ items: Page[] }>(
        `/v1/admin/content/pages?store_id=${encodeURIComponent(store.id)}`,
        { headers: headers() },
      );
      setPages(response.items);
      const next = response.items.find(({ id }) => id === selectedId) ?? response.items[0];
      setSelectedId(next?.id ?? '');
      setModules(normalizeModules(next));
    } catch (cause) {
      setPages([]);
      setSelectedId('');
      setModules([]);
      setError(cause instanceof Error ? cause.message : 'INTERNAL_ERROR');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [store.id]);
  useEffect(() => {
    setEditingLocale(locale);
  }, [locale]);

  const selectPage = (page: Page): void => {
    setSelectedId(page.id);
    setModules(normalizeModules(page));
    setError(undefined);
    setNotice(undefined);
  };
  const updateModule = (index: number, change: Partial<PageModule>): void => {
    setModules((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...change } : item)),
    );
  };
  const updateLocalization = (index: number, change: Partial<Localization>): void => {
    const module = modules[index];
    if (!module) return;
    updateModule(index, {
      localizations: module.localizations.map((item) =>
        item.locale === editingLocale ? { ...item, ...change } : item,
      ),
    });
  };
  const move = (from: number, to: number): void => {
    if (to < 0 || to >= modules.length || from === to) return;
    setModules((current) => {
      const next = [...current];
      const [item] = next.splice(from, 1);
      if (!item) return current;
      next.splice(to, 0, item);
      return next.map((module, index) => ({ ...module, sort_order: index }));
    });
  };
  const remove = (index: number): void =>
    setModules((current) =>
      current
        .filter((_, itemIndex) => itemIndex !== index)
        .map((item, itemIndex) => ({ ...item, sort_order: itemIndex })),
    );
  const replacePage = (page: Page): void => {
    setPages((current) => current.map((item) => (item.id === page.id ? page : item)));
    setModules(normalizeModules(page));
  };

  const createPage = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const page = await request<Page>(
        `/v1/admin/content/pages?store_id=${encodeURIComponent(store.id)}`,
        {
          body: JSON.stringify({ code: pageCode }),
          headers: { ...headers(), 'Content-Type': 'application/json' },
          method: 'POST',
        },
      );
      setPages((current) => [...current, page]);
      selectPage(page);
      setCreatingPage(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'INTERNAL_ERROR');
    } finally {
      setSaving(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!selected) return;
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const page = await request<Page>(
        `/v1/admin/content/pages/${selected.id}/draft?store_id=${encodeURIComponent(store.id)}`,
        {
          body: JSON.stringify({
            expected_version: selected.version,
            modules: modules.map((module, index) => ({
              background_config: module.background_config,
              localizations: module.localizations,
              media: module.media,
              module_type: module.module_type,
              sort_order: index,
              status: module.status,
              target_id: module.target_id,
              target_type: module.target_type,
              target_url: module.target_url,
              visible_from: apiDate(module.visible_from),
              visible_to: apiDate(module.visible_to),
            })),
          }),
          headers: { ...headers(), 'Content-Type': 'application/json' },
          method: 'PUT',
        },
      );
      replacePage(page);
      setNotice(t.saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'INTERNAL_ERROR');
    } finally {
      setSaving(false);
    }
  };

  const publish = async (): Promise<void> => {
    if (!selected) return;
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const page = await request<Page>(
        `/v1/admin/content/pages/${selected.id}/publish?store_id=${encodeURIComponent(store.id)}`,
        {
          body: JSON.stringify({
            confirmation_code: confirmation,
            expected_version: selected.version,
          }),
          headers: { ...headers(), 'Content-Type': 'application/json' },
          method: 'POST',
        },
      );
      replacePage(page);
      setConfirming(false);
      setConfirmation('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'INTERNAL_ERROR');
      setConfirming(false);
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return (
      <section className="content-state" aria-live="polite">
        {t.loading}
      </section>
    );
  if (error && pages.length === 0)
    return (
      <section className="content-state error-state" role="alert">
        <p>{error === 'AUTHORIZATION_DENIED' ? t.denied : t.error}</p>
        <button className="secondary" onClick={() => void load()}>
          {t.retry}
        </button>
      </section>
    );
  if (!pages.length)
    return (
      <section className="data-section content-empty">
        <p className="eyebrow">Content studio</p>
        <h2>{t.empty}</h2>
        <p>{t.createHint}</p>
        <form onSubmit={(event) => void createPage(event)}>
          <label>
            {t.pageCode}
            <input
              pattern="[a-z][a-z0-9\-]{1,63}"
              required
              value={pageCode}
              onChange={(event) => setPageCode(event.target.value)}
            />
          </label>
          <button className="primary" disabled={saving} type="submit">
            {t.create}
          </button>
        </form>
        {error && (
          <p className="form-error" role="alert">
            {t.error}
          </p>
        )}
      </section>
    );

  return (
    <section className="content-studio">
      <header className="content-toolbar">
        <div>
          <p className="eyebrow">Content studio</p>
          <h2>{selected?.code}</h2>
          <span className={`status-pill ${selected?.status.toLowerCase()}`}>
            {selected?.status} · v{selected?.version}
          </span>
        </div>
        <div className="toolbar-actions">
          <button
            className="secondary"
            disabled={saving}
            onClick={() => setCreatingPage((value) => !value)}
          >
            ＋ {t.newPage}
          </button>
          <button className="secondary" disabled={saving} onClick={() => void load()}>
            {t.retry}
          </button>
          <button className="secondary" disabled={saving || !selected} onClick={() => void save()}>
            {t.save}
          </button>
          <button
            className="primary"
            disabled={saving || !selected || modules.length === 0}
            onClick={() => setConfirming(true)}
          >
            {t.publish}
          </button>
        </div>
      </header>
      {creatingPage && (
        <form className="inline-page-form" onSubmit={(event) => void createPage(event)}>
          <label>
            {t.pageCode}
            <input
              pattern="[a-z][a-z0-9\-]{1,63}"
              required
              value={pageCode}
              onChange={(event) => setPageCode(event.target.value)}
            />
          </label>
          <button className="primary" disabled={saving} type="submit">
            {t.create}
          </button>
        </form>
      )}
      {error && (
        <div className="dashboard-error" role="alert">
          <strong>{error === 'CONFLICT' ? t.conflict : t.error}</strong>
          <button onClick={() => void load()}>{t.retry}</button>
        </div>
      )}
      {notice && (
        <p className="content-notice" role="status">
          {notice}
        </p>
      )}
      <div className="content-layout">
        <aside className="page-rail" aria-label={t.pageCode}>
          {pages.map((page) => (
            <button
              className={page.id === selectedId ? 'active' : ''}
              key={page.id}
              onClick={() => selectPage(page)}
            >
              <strong>{page.code}</strong>
              <small>
                {page.status} · v{page.version}
              </small>
            </button>
          ))}
        </aside>
        <div className="module-editor">
          <div className="editor-controls">
            <div className="locale-switch" aria-label="Content language">
              {(['vi', 'zh', 'en'] as const).map((item) => (
                <button
                  className={editingLocale === item ? 'active' : ''}
                  key={item}
                  onClick={() => setEditingLocale(item)}
                >
                  {item.toUpperCase()}
                </button>
              ))}
            </div>
            <button
              className="secondary"
              onClick={() => setModules((current) => [...current, blankModule(current.length)])}
            >
              ＋ {t.add}
            </button>
          </div>
          {modules.length === 0 ? (
            <p className="empty-state">{t.empty}</p>
          ) : (
            modules.map((module, index) => {
              const localization = module.localizations.find(
                ({ locale: item }) => item === editingLocale,
              )!;
              return (
                <article
                  className="module-card"
                  draggable
                  key={module.id ?? `new-${index}`}
                  onDragStart={() => setDragged(index)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (dragged !== undefined) move(dragged, index);
                    setDragged(undefined);
                  }}
                >
                  <header>
                    <span className="drag-handle" aria-hidden="true">
                      ⠿
                    </span>
                    <strong>
                      {t.module} {index + 1}
                    </strong>
                    <select
                      aria-label="Module type"
                      value={module.module_type}
                      onChange={(event) =>
                        updateModule(index, {
                          module_type: event.target.value as PageModule['module_type'],
                        })
                      }
                    >
                      {moduleTypes.map((type) => (
                        <option key={type}>{type}</option>
                      ))}
                    </select>
                    <div className="module-actions">
                      <button
                        aria-label="Move up"
                        disabled={index === 0}
                        onClick={() => move(index, index - 1)}
                      >
                        ↑
                      </button>
                      <button
                        aria-label="Move down"
                        disabled={index === modules.length - 1}
                        onClick={() => move(index, index + 1)}
                      >
                        ↓
                      </button>
                      <button aria-label="Delete module" onClick={() => remove(index)}>
                        ×
                      </button>
                    </div>
                  </header>
                  <div className="module-fields">
                    <label>
                      {t.title}
                      <input
                        maxLength={240}
                        required
                        value={localization.title}
                        onChange={(event) =>
                          updateLocalization(index, { title: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      {t.summary}
                      <input
                        maxLength={500}
                        value={localization.summary ?? ''}
                        onChange={(event) =>
                          updateLocalization(index, { summary: event.target.value || null })
                        }
                      />
                    </label>
                    <label>
                      {t.from}
                      <input
                        type="datetime-local"
                        value={localInput(module.visible_from)}
                        onChange={(event) =>
                          updateModule(index, { visible_from: event.target.value || null })
                        }
                      />
                    </label>
                    <label>
                      {t.to}
                      <input
                        type="datetime-local"
                        value={localInput(module.visible_to)}
                        onChange={(event) =>
                          updateModule(index, { visible_to: event.target.value || null })
                        }
                      />
                    </label>
                    <label>
                      Background
                      <input
                        type="color"
                        value={module.background_config.color ?? '#ffffff'}
                        onChange={(event) =>
                          updateModule(index, {
                            background_config: {
                              ...module.background_config,
                              color: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      Target
                      <select
                        value={module.target_type ?? ''}
                        onChange={(event) => {
                          const value = event.target.value as PageModule['target_type'] | '';
                          updateModule(index, {
                            target_id: null,
                            target_type: value || null,
                            target_url: null,
                          });
                        }}
                      >
                        <option value="">{t.noTarget}</option>
                        {targetTypes.map((type) => (
                          <option key={type}>{type}</option>
                        ))}
                      </select>
                    </label>
                    {module.target_type === 'EXTERNAL' ? (
                      <label className="wide">
                        URL
                        <input
                          placeholder="https://"
                          type="url"
                          value={module.target_url ?? ''}
                          onChange={(event) =>
                            updateModule(index, { target_url: event.target.value || null })
                          }
                        />
                        <small>{t.external}</small>
                      </label>
                    ) : module.target_type ? (
                      <label className="wide">
                        Target ID
                        <input
                          value={module.target_id ?? ''}
                          onChange={(event) =>
                            updateModule(index, { target_id: event.target.value || null })
                          }
                        />
                      </label>
                    ) : null}
                    <label className="check-field">
                      <input
                        checked={module.status === 'ACTIVE'}
                        onChange={(event) =>
                          updateModule(index, {
                            status: event.target.checked ? 'ACTIVE' : 'DISABLED',
                          })
                        }
                        type="checkbox"
                      />{' '}
                      Active
                    </label>
                  </div>
                </article>
              );
            })
          )}
        </div>
        <aside className={`phone-preview ${store.code.includes('fashion') ? 'fashion' : 'beauty'}`}>
          <div className="phone-top">
            <span /> <small>{store.code}</small>
          </div>
          <p className="preview-label">{t.preview}</p>
          {modules
            .filter(({ status }) => status === 'ACTIVE')
            .map((module, index) => {
              const text =
                module.localizations.find(({ locale: item }) => item === editingLocale) ??
                module.localizations[0]!;
              return (
                <article
                  key={module.id ?? index}
                  style={{ background: module.background_config.color ?? undefined }}
                >
                  <small>{module.module_type.replace('_', ' ')}</small>
                  <h3>{text.title}</h3>
                  {text.summary && <p>{text.summary}</p>}
                </article>
              );
            })}
        </aside>
      </div>
      {confirming && (
        <div className="modal-backdrop" role="presentation">
          <section
            aria-labelledby="publish-title"
            aria-modal="true"
            className="confirm-modal"
            role="dialog"
          >
            <h2 id="publish-title">{t.publishTitle}</h2>
            <p>{t.publishBody}</p>
            <label>
              {t.pageCode}
              <input
                autoFocus
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
            <div>
              <button
                className="secondary"
                onClick={() => {
                  setConfirming(false);
                  setConfirmation('');
                }}
              >
                Cancel
              </button>
              <button
                className="primary"
                disabled={confirmation.trim().toLowerCase() !== selected?.code || saving}
                onClick={() => void publish()}
              >
                {t.publish}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
