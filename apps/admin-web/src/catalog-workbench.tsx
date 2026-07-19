import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

type Locale = 'en' | 'vi' | 'zh';
type Store = { code: string; default_locale: Locale; id: string };
type Request = <T>(path: string, options?: RequestInit) => Promise<T>;
type Localization = {
  description?: string | null;
  introduction?: string | null;
  locale: Locale;
  name: string;
  sellingPoints?: string | null;
};
type Brand = {
  brand_localizations: Localization[];
  code: string;
  countryCode: string | null;
  id: string;
  recommended: boolean;
  sortOrder: number;
  status: 'ACTIVE' | 'DISABLED';
  version: number;
  websiteUrl: string | null;
};
type TemplateVersion = {
  attribute_definitions: Array<{
    attribute_options: Array<{
      code: string;
      labelEn: string | null;
      labelVi: string;
      labelZh: string | null;
    }>;
    code: string;
    dataType: AttributeType;
    filterable: boolean;
    labelEn: string | null;
    labelVi: string;
    labelZh: string | null;
    multiple: boolean;
    purpose: AttributePurpose;
    required: boolean;
  }>;
  id: string;
  name: string;
  status: 'ACTIVE' | 'DRAFT' | 'RETIRED';
  version: number;
};
type Template = {
  attribute_template_versions: TemplateVersion[];
  code: string;
  currentVersion: number | null;
  id: string;
  status: string;
  version: number;
};
type CategoryBinding = {
  attribute_template_versions: {
    attribute_templates: { code: string; id: string };
    id: string;
    name: string;
    status: string;
    version: number;
  };
  isPrimary: boolean;
  templateVersionId: string;
};
type Category = {
  category_attribute_templates: CategoryBinding[];
  category_localizations: Localization[];
  children?: Category[];
  code: string;
  depth: number;
  id: string;
  parentId: string | null;
  sortOrder: number;
  status: 'ACTIVE' | 'DISABLED';
  version: number;
};
type Product = {
  code: string;
  enabled: boolean;
  id: string;
  product_localizations: Localization[];
  skus: Array<{
    code: string;
    marketPriceVnd: string | number | null;
    salePriceVnd: string | number;
    status: string;
  }>;
  status: 'DISABLED' | 'DRAFT' | 'PENDING_REVIEW' | 'PUBLISHED' | 'UNPUBLISHED';
  version: number;
};
type AttributeType = 'BOOLEAN' | 'DATE' | 'DECIMAL' | 'INTEGER' | 'OPTION' | 'TEXT';
type AttributePurpose = 'COMPLIANCE' | 'DETAIL' | 'FILTER' | 'SPECIFICATION';
type AttributeDefinition = {
  code: string;
  data_type: AttributeType;
  labels: Record<Locale, string | null>;
  multiple: boolean;
  options: Array<{ code: string; labels: Record<Locale, string | null> }>;
  purpose: AttributePurpose;
  required: boolean;
  unit: string | null;
};
type AttributeValue = {
  attribute_code: string;
  data_type: AttributeType;
  locale?: Locale;
  option_code?: string;
  value?: boolean | number | string;
};
type AttributeEditor = {
  definitions: AttributeDefinition[];
  editable: boolean;
  product_status: string;
  product_version: number;
  template_version: { id: string; name: string; version: number };
  values: AttributeValue[];
};
type PublicationIssue = { code: string; reference?: string } | string;
type ComplianceOverview = {
  records: Array<{
    document_number_masked: string | null;
    expires_on: string | null;
    id: string;
    media_count: number;
    product: { code: string; id: string; name_vi: string };
    requirement: { blocking: boolean; code: string; document_type: string; id: string };
    reviewed_at: string | null;
    status: string;
    submitted_at: string;
    version: number;
  }>;
  requirements: Array<{
    blocking: boolean;
    category_id: string | null;
    code: string;
    document_type: string;
    id: string;
    version: number;
  }>;
};
type Section = 'brands' | 'categories' | 'compliance' | 'products' | 'templates';

const copy = {
  vi: {
    activate: 'Kích hoạt phiên bản',
    activeRequirements: 'Yêu cầu tuân thủ đang áp dụng',
    add: 'Thêm',
    approve: 'Phê duyệt',
    attributes: 'Thuộc tính',
    bind: 'Mẫu thuộc tính chính',
    blocking: 'bắt buộc',
    brands: 'Thương hiệu',
    cancel: 'Hủy',
    categories: 'Danh mục',
    code: 'Mã',
    compliance: 'Tuân thủ',
    confirm: 'Xác nhận',
    country: 'Quốc gia ISO',
    create: 'Tạo mới',
    description: 'Mô tả',
    disabled: 'Đã tắt',
    disableProduct: 'Ngừng bán',
    edit: 'Chỉnh sửa',
    empty: 'Chưa có dữ liệu trong phạm vi cửa hàng này.',
    error: 'Không thể hoàn tất yêu cầu.',
    files: 'tệp',
    filter: 'Tìm theo mã hoặc tên',
    leaf: 'Danh mục cuối',
    loading: 'Đang tải dữ liệu…',
    multiple: 'Nhiều giá trị',
    name: 'Tên',
    notice: 'Thao tác đã hoàn tất.',
    onePerLine: 'mỗi dòng một giá trị',
    options: 'Tùy chọn',
    parent: 'Danh mục cha',
    products: 'Sản phẩm',
    publish: 'Xuất bản',
    purpose: 'Mục đích',
    recommended: 'Đề xuất',
    reject: 'Từ chối',
    required: 'Bắt buộc',
    retry: 'Thử lại',
    review: 'Duyệt hồ sơ',
    reviewNote: 'Ghi chú đánh giá',
    root: 'Danh mục gốc',
    save: 'Lưu',
    sellingPoints: 'Điểm nổi bật',
    sort: 'Thứ tự',
    status: 'Trạng thái',
    submit: 'Gửi kiểm tra',
    templates: 'Mẫu thuộc tính',
    title: 'Danh mục & tuân thủ',
    typeCode: 'Nhập mã xác nhận',
    type: 'Kiểu dữ liệu',
    version: 'Phiên bản',
    website: 'Website chính thức',
  },
  zh: {
    activate: '启用版本',
    activeRequirements: '当前生效合规要求',
    add: '添加',
    approve: '批准',
    attributes: '属性',
    bind: '主属性模板',
    blocking: '强制',
    brands: '品牌',
    cancel: '取消',
    categories: '类目',
    code: '编码',
    compliance: '合规',
    confirm: '确认',
    country: 'ISO 国家代码',
    create: '新建',
    description: '描述',
    disabled: '已停用',
    disableProduct: '停用商品',
    edit: '编辑',
    empty: '当前商城范围内暂无数据。',
    error: '请求未能完成。',
    files: '个文件',
    filter: '按编码或名称搜索',
    leaf: '末级类目',
    loading: '正在加载数据…',
    multiple: '允许多值',
    name: '名称',
    notice: '操作已完成。',
    onePerLine: '每行一个值',
    options: '选项',
    parent: '父类目',
    products: '商品',
    publish: '发布',
    purpose: '用途',
    recommended: '推荐',
    reject: '驳回',
    required: '必填',
    retry: '重试',
    review: '审核记录',
    reviewNote: '审核意见',
    root: '根类目',
    save: '保存',
    sellingPoints: '卖点',
    sort: '排序',
    status: '状态',
    submit: '提交检查',
    templates: '属性模板',
    title: '商品与合规工作台',
    typeCode: '输入确认码',
    type: '数据类型',
    version: '版本',
    website: '官方网站',
  },
  en: {
    activate: 'Activate version',
    activeRequirements: 'Active compliance requirements',
    add: 'Add',
    approve: 'Approve',
    attributes: 'Attributes',
    bind: 'Primary attribute template',
    blocking: 'blocking',
    brands: 'Brands',
    cancel: 'Cancel',
    categories: 'Categories',
    code: 'Code',
    compliance: 'Compliance',
    confirm: 'Confirm',
    country: 'ISO country',
    create: 'Create',
    description: 'Description',
    disabled: 'Disabled',
    disableProduct: 'Disable product',
    edit: 'Edit',
    empty: 'No data exists in this store scope.',
    error: 'The request could not be completed.',
    files: 'files',
    filter: 'Search by code or name',
    leaf: 'Leaf category',
    loading: 'Loading data…',
    multiple: 'Multiple values',
    name: 'Name',
    notice: 'Action completed.',
    onePerLine: 'one value per line',
    options: 'Options',
    parent: 'Parent category',
    products: 'Products',
    publish: 'Publish',
    purpose: 'Purpose',
    recommended: 'Recommended',
    reject: 'Reject',
    required: 'Required',
    retry: 'Retry',
    review: 'Review record',
    reviewNote: 'Review note',
    root: 'Root category',
    save: 'Save',
    sellingPoints: 'Selling points',
    sort: 'Sort order',
    status: 'Status',
    submit: 'Submit checks',
    templates: 'Attribute templates',
    title: 'Catalog & compliance',
    typeCode: 'Type confirmation code',
    type: 'Data type',
    version: 'Version',
    website: 'Official website',
  },
} as const;

function localizedName(localizations: Localization[], locale: Locale): string {
  return (
    localizations.find((item) => item.locale === locale)?.name ??
    localizations.find((item) => item.locale === 'vi')?.name ??
    '—'
  );
}

function flattenCategories(categories: Category[]): Category[] {
  return categories.flatMap((category) => [category, ...(category.children ?? [])]);
}

function jsonOptions(headers: () => Record<string, string>): Record<string, string> {
  return { ...headers(), 'Content-Type': 'application/json' };
}

function formString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function Dialog({ children, title }: { children: ReactNode; title: string }): JSX.Element {
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        aria-labelledby="catalog-dialog-title"
        aria-modal="true"
        className="catalog-dialog"
        role="dialog"
      >
        <h2 id="catalog-dialog-title">{title}</h2>
        {children}
      </section>
    </div>
  );
}

function DialogActions({
  cancel,
  cancelLabel,
  saveLabel,
}: {
  cancel: () => void;
  cancelLabel: string;
  saveLabel: string;
}): JSX.Element {
  return (
    <div className="dialog-actions">
      <button className="secondary" onClick={cancel} type="button">
        {cancelLabel}
      </button>
      <button className="primary" type="submit">
        {saveLabel}
      </button>
    </div>
  );
}

function LocalizationFields({
  initial,
  t,
}: {
  initial?: Localization[];
  t: (typeof copy)[Locale];
}): JSX.Element {
  return (
    <fieldset className="translation-fields">
      <legend>VI / 中文 / EN</legend>
      {(['vi', 'zh', 'en'] as const).map((locale) => {
        const item = initial?.find((candidate) => candidate.locale === locale);
        return (
          <div className="translation-row" key={locale}>
            <strong>{locale.toUpperCase()}</strong>
            <label>
              {t.name}
              <input
                defaultValue={item?.name ?? ''}
                name={`name_${locale}`}
                required={locale === 'vi'}
              />
            </label>
            <label>
              {t.description}
              <textarea
                defaultValue={item?.description ?? item?.introduction ?? ''}
                name={`description_${locale}`}
                rows={2}
              />
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}

function localizationsFromForm(form: FormData, product = false): Array<Record<string, unknown>> {
  return (['vi', 'zh', 'en'] as const).flatMap((locale) => {
    const name = formString(form, `name_${locale}`).trim();
    if (!name) return [];
    const description = formString(form, `description_${locale}`).trim() || null;
    return [
      {
        description,
        locale,
        name,
        ...(product
          ? { selling_points: formString(form, `selling_${locale}`).trim() || null }
          : {}),
      },
    ];
  });
}

function BrandDialog({
  brand,
  close,
  locale,
  save,
}: {
  brand?: Brand;
  close: () => void;
  locale: Locale;
  save: (path: string, method: string, body: unknown) => void;
}): JSX.Element {
  const t = copy[locale];
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const common = {
      country_code: formString(form, 'country').trim().toUpperCase() || null,
      localizations: localizationsFromForm(form),
      official_website: formString(form, 'website').trim() || null,
      recommended: form.get('recommended') === 'on',
      sort_order: Number(form.get('sort')),
    };
    save(
      brand ? `/v1/admin/catalog/brands/${brand.id}` : '/v1/admin/catalog/brands',
      brand ? 'PATCH' : 'POST',
      brand
        ? { ...common, expected_version: brand.version, status: form.get('status') }
        : { ...common, code: form.get('code') },
    );
  };
  return (
    <Dialog title={`${brand ? t.edit : t.create} · ${t.brands}`}>
      <form className="catalog-form" onSubmit={submit}>
        <div className="form-grid">
          <label>
            {t.code}
            <input
              defaultValue={brand?.code ?? ''}
              disabled={Boolean(brand)}
              name="code"
              pattern="[a-z][a-z0-9-]{1,63}"
              required
            />
          </label>
          <label>
            {t.sort}
            <input
              defaultValue={brand?.sortOrder ?? 0}
              min="0"
              name="sort"
              required
              type="number"
            />
          </label>
          <label>
            {t.country}
            <input
              defaultValue={brand?.countryCode ?? 'VN'}
              maxLength={2}
              name="country"
              pattern="[A-Za-z]{2}"
            />
          </label>
          <label>
            {t.website}
            <input
              defaultValue={brand?.websiteUrl ?? ''}
              name="website"
              placeholder="https://"
              type="url"
            />
          </label>
          {brand && (
            <label>
              {t.status}
              <select defaultValue={brand.status} name="status">
                <option value="ACTIVE">ACTIVE</option>
                <option value="DISABLED">DISABLED</option>
              </select>
            </label>
          )}
          <label className="check-field">
            <input defaultChecked={brand?.recommended} name="recommended" type="checkbox" />
            {t.recommended}
          </label>
        </div>
        <LocalizationFields initial={brand?.brand_localizations} t={t} />
        <DialogActions cancel={close} cancelLabel={t.cancel} saveLabel={t.save} />
      </form>
    </Dialog>
  );
}

function CategoryDialog({
  category,
  categories,
  close,
  locale,
  save,
}: {
  category?: Category;
  categories: Category[];
  close: () => void;
  locale: Locale;
  save: (path: string, method: string, body: unknown) => void;
}): JSX.Element {
  const t = copy[locale];
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const common = {
      localizations: localizationsFromForm(form),
      parent_id: formString(form, 'parent') || null,
      sort_order: Number(form.get('sort')),
    };
    save(
      category ? `/v1/admin/catalog/categories/${category.id}` : '/v1/admin/catalog/categories',
      category ? 'PATCH' : 'POST',
      category
        ? { ...common, expected_version: category.version, status: form.get('status') }
        : { ...common, code: form.get('code') },
    );
  };
  return (
    <Dialog title={`${category ? t.edit : t.create} · ${t.categories}`}>
      <form className="catalog-form" onSubmit={submit}>
        <div className="form-grid">
          <label>
            {t.code}
            <input
              defaultValue={category?.code ?? ''}
              disabled={Boolean(category)}
              name="code"
              pattern="[a-z][a-z0-9-]{1,63}"
              required
            />
          </label>
          <label>
            {t.sort}
            <input
              defaultValue={category?.sortOrder ?? 0}
              min="0"
              name="sort"
              required
              type="number"
            />
          </label>
          <label>
            {t.parent}
            <select defaultValue={category?.parentId ?? ''} name="parent">
              <option value="">—</option>
              {categories
                .filter((item) => item.depth === 1 && item.id !== category?.id)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {localizedName(item.category_localizations, locale)}
                  </option>
                ))}
            </select>
          </label>
          {category && (
            <label>
              {t.status}
              <select defaultValue={category.status} name="status">
                <option value="ACTIVE">ACTIVE</option>
                <option value="DISABLED">DISABLED</option>
              </select>
            </label>
          )}
        </div>
        <LocalizationFields initial={category?.category_localizations} t={t} />
        <DialogActions cancel={close} cancelLabel={t.cancel} saveLabel={t.save} />
      </form>
    </Dialog>
  );
}

type DefinitionDraft = {
  code: string;
  dataType: AttributeType;
  labelEn: string;
  labelVi: string;
  labelZh: string;
  multiple: boolean;
  options: string;
  purpose: AttributePurpose;
  required: boolean;
};
const emptyDefinition = (): DefinitionDraft => ({
  code: '',
  dataType: 'TEXT',
  labelEn: '',
  labelVi: '',
  labelZh: '',
  multiple: false,
  options: '',
  purpose: 'DETAIL',
  required: false,
});

function TemplateDialog({
  close,
  locale,
  save,
}: {
  close: () => void;
  locale: Locale;
  save: (path: string, method: string, body: unknown) => void;
}): JSX.Element {
  const t = copy[locale];
  const [definitions, setDefinitions] = useState<DefinitionDraft[]>([emptyDefinition()]);
  const update = (index: number, value: Partial<DefinitionDraft>): void =>
    setDefinitions((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...value } : item)),
    );
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    save('/v1/admin/catalog/attribute-templates', 'POST', {
      code: form.get('code'),
      definitions: definitions.map((definition, index) => ({
        code: definition.code,
        data_type: definition.purpose === 'SPECIFICATION' ? 'OPTION' : definition.dataType,
        filterable: definition.purpose === 'FILTER',
        label_en: definition.labelEn || null,
        label_vi: definition.labelVi,
        label_zh: definition.labelZh || null,
        multiple: definition.multiple,
        options:
          definition.purpose === 'SPECIFICATION' || definition.dataType === 'OPTION'
            ? definition.options
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean)
                .map((value, optionIndex) => {
                  const [code, labelVi = code, labelZh = '', labelEn = ''] = value
                    .split('|')
                    .map((part) => part.trim());
                  return {
                    code,
                    label_en: labelEn || null,
                    label_vi: labelVi,
                    label_zh: labelZh || null,
                    sort_order: optionIndex,
                  };
                })
            : [],
        purpose: definition.purpose,
        required: definition.required,
        sort_order: index,
        unit: null,
        validation_rules: {},
      })),
      name: form.get('name'),
    });
  };
  return (
    <Dialog title={`${t.create} · ${t.templates}`}>
      <form className="catalog-form" onSubmit={submit}>
        <div className="form-grid">
          <label>
            {t.code}
            <input name="code" pattern="[a-z][a-z0-9-]{1,63}" required />
          </label>
          <label>
            {t.name}
            <input name="name" required />
          </label>
        </div>
        <div className="definition-builder">
          {definitions.map((definition, index) => (
            <fieldset key={index}>
              <legend>
                {t.attributes} {index + 1}
              </legend>
              <div className="form-grid">
                <label>
                  {t.code}
                  <input
                    onChange={(event) => update(index, { code: event.target.value })}
                    pattern="[a-z][a-z0-9-]{1,63}"
                    required
                    value={definition.code}
                  />
                </label>
                <label>
                  {t.purpose}
                  <select
                    onChange={(event) =>
                      update(index, { purpose: event.target.value as AttributePurpose })
                    }
                    value={definition.purpose}
                  >
                    <option>DETAIL</option>
                    <option>FILTER</option>
                    <option>SPECIFICATION</option>
                    <option>COMPLIANCE</option>
                  </select>
                </label>
                <label>
                  {t.type}
                  <select
                    disabled={definition.purpose === 'SPECIFICATION'}
                    onChange={(event) =>
                      update(index, { dataType: event.target.value as AttributeType })
                    }
                    value={definition.purpose === 'SPECIFICATION' ? 'OPTION' : definition.dataType}
                  >
                    <option>TEXT</option>
                    <option>OPTION</option>
                    <option>INTEGER</option>
                    <option>DECIMAL</option>
                    <option>BOOLEAN</option>
                    <option>DATE</option>
                  </select>
                </label>
                <label>
                  VI
                  <input
                    onChange={(event) => update(index, { labelVi: event.target.value })}
                    required
                    value={definition.labelVi}
                  />
                </label>
                <label>
                  中文
                  <input
                    onChange={(event) => update(index, { labelZh: event.target.value })}
                    value={definition.labelZh}
                  />
                </label>
                <label>
                  EN
                  <input
                    onChange={(event) => update(index, { labelEn: event.target.value })}
                    value={definition.labelEn}
                  />
                </label>
                {(definition.dataType === 'OPTION' || definition.purpose === 'SPECIFICATION') && (
                  <label className="wide">
                    {t.options} <small>code|VI|中文|EN, …</small>
                    <textarea
                      onChange={(event) => update(index, { options: event.target.value })}
                      required
                      rows={2}
                      value={definition.options}
                    />
                  </label>
                )}
                <label className="check-field">
                  <input
                    checked={definition.required}
                    onChange={(event) => update(index, { required: event.target.checked })}
                    type="checkbox"
                  />
                  {t.required}
                </label>
                <label className="check-field">
                  <input
                    checked={definition.multiple}
                    onChange={(event) => update(index, { multiple: event.target.checked })}
                    type="checkbox"
                  />
                  {t.multiple}
                </label>
              </div>
              {definitions.length > 1 && (
                <button
                  className="text-button"
                  onClick={() =>
                    setDefinitions((items) => items.filter((_, itemIndex) => itemIndex !== index))
                  }
                  type="button"
                >
                  × {t.cancel}
                </button>
              )}
            </fieldset>
          ))}
          <button
            className="secondary"
            onClick={() => setDefinitions((items) => [...items, emptyDefinition()])}
            type="button"
          >
            + {t.add} {t.attributes}
          </button>
        </div>
        <DialogActions cancel={close} cancelLabel={t.cancel} saveLabel={t.save} />
      </form>
    </Dialog>
  );
}

function ProductDialog({
  brands,
  categories,
  close,
  locale,
  save,
}: {
  brands: Brand[];
  categories: Category[];
  close: () => void;
  locale: Locale;
  save: (path: string, method: string, body: unknown) => void;
}): JSX.Element {
  const t = copy[locale];
  const leaves = categories.filter(
    (category) =>
      category.depth === 2 &&
      category.status === 'ACTIVE' &&
      category.category_attribute_templates.some(
        (binding) => binding.isPrimary && binding.attribute_template_versions.status === 'ACTIVE',
      ),
  );
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    save('/v1/admin/catalog/products', 'POST', {
      brand_id: form.get('brand'),
      code: form.get('code'),
      localizations: localizationsFromForm(form, true),
      main_category_id: form.get('category'),
      secondary_category_ids: [],
    });
  };
  return (
    <Dialog title={`${t.create} · ${t.products}`}>
      <form className="catalog-form" onSubmit={submit}>
        <div className="form-grid">
          <label>
            {t.code}
            <input name="code" pattern="[a-z][a-z0-9-]{1,63}" required />
          </label>
          <label>
            {t.brands}
            <select name="brand" required>
              <option value="">—</option>
              {brands
                .filter((brand) => brand.status === 'ACTIVE')
                .map((brand) => (
                  <option key={brand.id} value={brand.id}>
                    {localizedName(brand.brand_localizations, locale)}
                  </option>
                ))}
            </select>
          </label>
          <label>
            {t.categories}
            <select name="category" required>
              <option value="">—</option>
              {leaves.map((category) => (
                <option key={category.id} value={category.id}>
                  {localizedName(category.category_localizations, locale)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <LocalizationFields t={t} />
        <fieldset className="translation-fields">
          <legend>{t.sellingPoints}</legend>
          {(['vi', 'zh', 'en'] as const).map((language) => (
            <label key={language}>
              {language.toUpperCase()}
              <textarea name={`selling_${language}`} required={language === 'vi'} rows={2} />
            </label>
          ))}
        </fieldset>
        <DialogActions cancel={close} cancelLabel={t.cancel} saveLabel={t.save} />
      </form>
    </Dialog>
  );
}

function ConfirmDialog({
  action,
  close,
  locale,
  run,
}: {
  action: { code: string; description: string; label: string; run: () => void };
  close: () => void;
  locale: Locale;
  run: () => void;
}): JSX.Element {
  const t = copy[locale];
  const [typed, setTyped] = useState('');
  return (
    <Dialog title={action.label}>
      <p className="dialog-copy">{action.description}</p>
      <label>
        {t.typeCode}: <strong>{action.code}</strong>
        <input autoFocus onChange={(event) => setTyped(event.target.value)} value={typed} />
      </label>
      <div className="dialog-actions">
        <button className="secondary" onClick={close} type="button">
          {t.cancel}
        </button>
        <button className="primary" disabled={typed !== action.code} onClick={run} type="button">
          {t.confirm}
        </button>
      </div>
    </Dialog>
  );
}

function AttributeEditorPanel({
  editor,
  locale,
  onSave,
}: {
  editor: AttributeEditor;
  locale: Locale;
  onSave: (values: AttributeValue[]) => void;
}): JSX.Element {
  const t = copy[locale];
  const initial = useMemo(() => {
    const values: Record<string, boolean | string> = {};
    for (const definition of editor.definitions) {
      const matches = editor.values.filter((value) => value.attribute_code === definition.code);
      if (definition.data_type === 'TEXT') {
        for (const language of ['vi', 'zh', 'en'] as const)
          values[`${definition.code}:${language}`] = matches
            .filter((value) => value.locale === language)
            .map((value) => String(value.value))
            .join('\n');
      } else if (definition.data_type === 'OPTION') {
        values[definition.code] = matches
          .map((value) => value.option_code)
          .filter(Boolean)
          .join(',');
      } else if (definition.data_type === 'BOOLEAN') {
        values[definition.code] = matches[0]?.value === true;
      } else {
        values[definition.code] = matches.map((value) => String(value.value)).join('\n');
      }
    }
    return values;
  }, [editor]);
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial), [initial]);
  const set = (key: string, value: boolean | string): void =>
    setDraft((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const output: AttributeValue[] = [];
    for (const definition of editor.definitions) {
      if (definition.data_type === 'TEXT') {
        for (const language of ['vi', 'zh', 'en'] as const) {
          const raw = String(draft[`${definition.code}:${language}`] ?? '').trim();
          const items = definition.multiple
            ? raw
                .split('\n')
                .map((value) => value.trim())
                .filter(Boolean)
            : raw
              ? [raw]
              : [];
          output.push(
            ...items.map((value) => ({
              attribute_code: definition.code,
              data_type: 'TEXT' as const,
              locale: language,
              value,
            })),
          );
        }
      } else if (definition.data_type === 'OPTION') {
        const codes = String(draft[definition.code] ?? '')
          .split(',')
          .filter(Boolean);
        output.push(
          ...codes.map((option_code) => ({
            attribute_code: definition.code,
            data_type: 'OPTION' as const,
            option_code,
          })),
        );
      } else if (definition.data_type === 'BOOLEAN') {
        output.push({
          attribute_code: definition.code,
          data_type: 'BOOLEAN',
          value: draft[definition.code] === true,
        });
      } else {
        const raw = String(draft[definition.code] ?? '').trim();
        const items = definition.multiple
          ? raw
              .split('\n')
              .map((value) => value.trim())
              .filter(Boolean)
          : raw
            ? [raw]
            : [];
        output.push(
          ...items.map((value) => ({
            attribute_code: definition.code,
            data_type: definition.data_type,
            value: definition.data_type === 'INTEGER' ? Number(value) : value,
          })),
        );
      }
    }
    onSave(output);
  };
  return (
    <form className="attribute-editor" onSubmit={submit}>
      <header>
        <div>
          <strong>{editor.template_version.name}</strong>
          <small>
            v{editor.template_version.version} · {editor.product_status}
          </small>
        </div>
        <button className="primary" disabled={!editor.editable} type="submit">
          {t.save}
        </button>
      </header>
      {editor.definitions.length === 0 ? (
        <p className="empty-state">{t.empty}</p>
      ) : (
        editor.definitions.map((definition) => {
          const label = definition.labels[locale] ?? definition.labels.vi ?? definition.code;
          return (
            <fieldset key={definition.code}>
              <legend>
                {label} {definition.required && <span>*</span>}
                <small>
                  {definition.code} · {definition.purpose}
                </small>
              </legend>
              {definition.data_type === 'TEXT' ? (
                (['vi', 'zh', 'en'] as const).map((language) => (
                  <label key={language}>
                    {language.toUpperCase()}
                    <textarea
                      disabled={!editor.editable}
                      onChange={(event) =>
                        set(`${definition.code}:${language}`, event.target.value)
                      }
                      rows={definition.multiple ? 3 : 2}
                      value={String(draft[`${definition.code}:${language}`] ?? '')}
                    />
                  </label>
                ))
              ) : definition.data_type === 'OPTION' ? (
                <div className="option-grid">
                  {definition.options.map((option) => {
                    const selected = String(draft[definition.code] ?? '')
                      .split(',')
                      .includes(option.code);
                    return (
                      <label className="option-check" key={option.code}>
                        <input
                          checked={selected}
                          disabled={
                            !editor.editable ||
                            (!definition.multiple && !selected && Boolean(draft[definition.code]))
                          }
                          onChange={(event) => {
                            const current = String(draft[definition.code] ?? '')
                              .split(',')
                              .filter(Boolean);
                            set(
                              definition.code,
                              event.target.checked
                                ? (definition.multiple
                                    ? [...current, option.code]
                                    : [option.code]
                                  ).join(',')
                                : current.filter((code) => code !== option.code).join(','),
                            );
                          }}
                          type="checkbox"
                        />
                        {option.labels[locale] ?? option.labels.vi ?? option.code}
                      </label>
                    );
                  })}
                </div>
              ) : definition.data_type === 'BOOLEAN' ? (
                <label className="check-field">
                  <input
                    checked={draft[definition.code] === true}
                    disabled={!editor.editable}
                    onChange={(event) => set(definition.code, event.target.checked)}
                    type="checkbox"
                  />
                  {label}
                </label>
              ) : (
                <label>
                  {definition.multiple ? `${label} (${t.onePerLine})` : label}
                  {definition.multiple ? (
                    <textarea
                      disabled={!editor.editable}
                      onChange={(event) => set(definition.code, event.target.value)}
                      rows={3}
                      value={String(draft[definition.code] ?? '')}
                    />
                  ) : (
                    <input
                      disabled={!editor.editable}
                      inputMode={definition.data_type === 'DECIMAL' ? 'decimal' : undefined}
                      onChange={(event) => set(definition.code, event.target.value)}
                      pattern={
                        definition.data_type === 'DECIMAL'
                          ? '-?(?:0|[1-9][0-9]{0,15})(?:\\.[0-9]{1,8})?'
                          : undefined
                      }
                      step={definition.data_type === 'INTEGER' ? '1' : undefined}
                      type={
                        definition.data_type === 'DATE'
                          ? 'date'
                          : definition.data_type === 'INTEGER'
                            ? 'number'
                            : 'text'
                      }
                      value={String(draft[definition.code] ?? '')}
                    />
                  )}
                </label>
              )}
            </fieldset>
          );
        })
      )}
    </form>
  );
}

export function CatalogWorkbench({
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
  const [section, setSection] = useState<Section>('products');
  const [brands, setBrands] = useState<Brand[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [compliance, setCompliance] = useState<ComplianceOverview>({
    records: [],
    requirements: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [filter, setFilter] = useState('');
  const [brandDialog, setBrandDialog] = useState<Brand | 'new'>();
  const [categoryDialog, setCategoryDialog] = useState<Category | 'new'>();
  const [templateDialog, setTemplateDialog] = useState(false);
  const [productDialog, setProductDialog] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product>();
  const [editor, setEditor] = useState<AttributeEditor>();
  const [issues, setIssues] = useState<PublicationIssue[]>([]);
  const [confirm, setConfirm] = useState<{
    code: string;
    description: string;
    label: string;
    run: () => void;
  }>();
  const [reviewRecord, setReviewRecord] = useState<ComplianceOverview['records'][number]>();
  const query = `store_id=${encodeURIComponent(store.id)}`;
  const selectSection = (next: Section): void => {
    setSection(next);
    setFilter('');
  };

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    const selectedId = selectedProduct?.id;
    try {
      const [brandResult, categoryResult, templateResult, productResult, complianceResult] =
        await Promise.all([
          request<{ items: Brand[] }>(`/v1/admin/catalog/brands?${query}`, { headers: headers() }),
          request<Category[]>(`/v1/admin/catalog/categories?${query}`, { headers: headers() }),
          request<Template[]>(`/v1/admin/catalog/attribute-templates?${query}`, {
            headers: headers(),
          }),
          request<{ items: Product[] }>(`/v1/admin/catalog/products?${query}`, {
            headers: headers(),
          }),
          request<ComplianceOverview>(`/v1/admin/compliance/overview?${query}&limit=50`, {
            headers: headers(),
          }),
        ]);
      setBrands(brandResult.items);
      setCategories(categoryResult);
      setTemplates(templateResult);
      setProducts(productResult.items);
      setCompliance(complianceResult);
      if (selectedId) {
        setSelectedProduct(productResult.items.find((item) => item.id === selectedId));
        setEditor(
          await request<AttributeEditor>(
            `/v1/admin/catalog/products/${selectedId}/attributes?${query}`,
            { headers: headers() },
          ),
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'INTERNAL_ERROR');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const mutate = async (
    path: string,
    method: string,
    body: unknown,
    message = t.notice,
  ): Promise<unknown> => {
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await request<unknown>(`${path}?${query}`, {
        body: JSON.stringify(body),
        headers: jsonOptions(headers),
        method,
      });
      setNotice(message);
      setBrandDialog(undefined);
      setCategoryDialog(undefined);
      setTemplateDialog(false);
      setProductDialog(false);
      setConfirm(undefined);
      setReviewRecord(undefined);
      await load();
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'INTERNAL_ERROR');
      return undefined;
    }
  };

  const allCategories = flattenCategories(categories);
  const searchable = (code: string, name: string): boolean =>
    `${code} ${name}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase());
  const filteredBrands = brands.filter((item) =>
    searchable(item.code, localizedName(item.brand_localizations, locale)),
  );
  const filteredCategories = allCategories.filter((item) =>
    searchable(item.code, localizedName(item.category_localizations, locale)),
  );
  const filteredProducts = products.filter((item) =>
    searchable(item.code, localizedName(item.product_localizations, locale)),
  );
  const activeVersions = templates.flatMap((template) =>
    template.attribute_template_versions
      .filter((version) => version.status === 'ACTIVE')
      .map((version) => ({ ...version, templateCode: template.code })),
  );

  const openProduct = async (product: Product): Promise<void> => {
    setSelectedProduct(product);
    setEditor(undefined);
    setIssues([]);
    try {
      setEditor(
        await request<AttributeEditor>(
          `/v1/admin/catalog/products/${product.id}/attributes?${query}`,
          { headers: headers() },
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'INTERNAL_ERROR');
    }
  };
  const productAction = async (product: Product, action: 'publish' | 'submit'): Promise<void> => {
    const result = (await mutate(`/v1/admin/catalog/products/${product.id}/${action}`, 'POST', {
      expected_version: product.version,
    })) as { can_publish?: boolean; issues?: PublicationIssue[] } | undefined;
    if (result?.can_publish === false) setIssues(result.issues ?? []);
  };

  if (loading && products.length === 0 && brands.length === 0)
    return (
      <section className="content-state">
        <p>{t.loading}</p>
      </section>
    );
  if (error && products.length === 0 && brands.length === 0)
    return (
      <section className="content-state error-state">
        <strong>{t.error}</strong>
        <small>{error}</small>
        <button className="secondary" onClick={() => void load()}>
          {t.retry}
        </button>
      </section>
    );

  return (
    <section className="catalog-workbench">
      <header className="catalog-heading">
        <div>
          <p className="eyebrow">M2.8 · {store.code}</p>
          <h2>{t.title}</h2>
        </div>
        <button className="secondary" disabled={loading} onClick={() => void load()}>
          {loading ? t.loading : t.retry}
        </button>
      </header>
      <div className="catalog-summary">
        {(
          [
            { key: 'products', value: products.length },
            { key: 'brands', value: brands.length },
            { key: 'categories', value: allCategories.length },
            { key: 'templates', value: templates.length },
            {
              key: 'compliance',
              value: compliance.records.filter((item) => item.status === 'PENDING_REVIEW').length,
            },
          ] as const
        ).map((item) => (
          <button
            className={section === item.key ? 'active' : ''}
            key={item.key}
            onClick={() => selectSection(item.key)}
          >
            <strong>{item.value}</strong>
            <span>{t[item.key]}</span>
          </button>
        ))}
      </div>
      <div className="catalog-toolbar">
        <nav aria-label={t.title}>
          {(['products', 'brands', 'categories', 'templates', 'compliance'] as const).map(
            (item) => (
              <button
                className={section === item ? 'active' : ''}
                key={item}
                onClick={() => selectSection(item)}
              >
                {t[item]}
              </button>
            ),
          )}
        </nav>
        {section !== 'compliance' && (
          <input
            aria-label={t.filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t.filter}
            type="search"
            value={filter}
          />
        )}
      </div>
      {error && (
        <div className="workbench-message error" role="alert">
          <strong>{t.error}</strong>
          <span>{error}</span>
          <button onClick={() => setError(undefined)}>×</button>
        </div>
      )}
      {notice && (
        <div className="workbench-message success" role="status">
          <span>{notice}</span>
          <button onClick={() => setNotice(undefined)}>×</button>
        </div>
      )}

      {section === 'brands' && (
        <div className="catalog-panel">
          <div className="panel-title">
            <h3>{t.brands}</h3>
            <button className="primary" onClick={() => setBrandDialog('new')}>
              + {t.create}
            </button>
          </div>
          {filteredBrands.length ? (
            <div className="entity-grid">
              {filteredBrands.map((brand) => (
                <article className="entity-card" key={brand.id}>
                  <div className="entity-monogram">
                    {localizedName(brand.brand_localizations, locale).slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <h4>{localizedName(brand.brand_localizations, locale)}</h4>
                    <p>
                      {brand.code} · v{brand.version}
                    </p>
                    <div className="tag-row">
                      <span
                        className={`status-pill ${brand.status === 'ACTIVE' ? 'published' : ''}`}
                      >
                        {brand.status}
                      </span>
                      {brand.recommended && <span className="soft-tag">{t.recommended}</span>}
                    </div>
                  </div>
                  <button
                    className="icon-button"
                    aria-label={t.edit}
                    onClick={() => setBrandDialog(brand)}
                  >
                    ✎
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <p className="empty-state">{t.empty}</p>
          )}
        </div>
      )}

      {section === 'categories' && (
        <div className="catalog-panel">
          <div className="panel-title">
            <h3>{t.categories}</h3>
            <button className="primary" onClick={() => setCategoryDialog('new')}>
              + {t.create}
            </button>
          </div>
          {filteredCategories.length ? (
            <div className="category-tree">
              {filteredCategories.map((category) => {
                const primary = category.category_attribute_templates.find(
                  (binding) => binding.isPrimary,
                );
                return (
                  <article className={category.depth === 2 ? 'child' : ''} key={category.id}>
                    <div>
                      <small>{category.depth === 2 ? `↳ ${t.leaf}` : t.root}</small>
                      <h4>{localizedName(category.category_localizations, locale)}</h4>
                      <p>
                        {category.code} · {category.status} · v{category.version}
                      </p>
                    </div>
                    {category.depth === 2 && (
                      <label>
                        {t.bind}
                        <select
                          aria-label={`${t.bind} ${category.code}`}
                          onChange={(event) =>
                            event.target.value &&
                            void mutate(
                              `/v1/admin/catalog/categories/${category.id}/attribute-templates/${event.target.value}`,
                              'PUT',
                              { is_primary: true },
                            )
                          }
                          value={primary?.templateVersionId ?? ''}
                        >
                          <option value="">—</option>
                          {activeVersions.map((version) => (
                            <option key={version.id} value={version.id}>
                              {version.templateCode} · v{version.version}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <button
                      className="icon-button"
                      aria-label={t.edit}
                      onClick={() => setCategoryDialog(category)}
                    >
                      ✎
                    </button>
                  </article>
                );
              })}
            </div>
          ) : (
            <p className="empty-state">{t.empty}</p>
          )}
        </div>
      )}

      {section === 'templates' && (
        <div className="catalog-panel">
          <div className="panel-title">
            <h3>{t.templates}</h3>
            <button className="primary" onClick={() => setTemplateDialog(true)}>
              + {t.create}
            </button>
          </div>
          {templates.length ? (
            <div className="template-list">
              {templates
                .filter((template) =>
                  searchable(template.code, template.attribute_template_versions[0]?.name ?? ''),
                )
                .map((template) => (
                  <article key={template.id}>
                    <header>
                      <div>
                        <h4>{template.attribute_template_versions[0]?.name ?? template.code}</h4>
                        <p>
                          {template.code} · {t.version} {template.version}
                        </p>
                      </div>
                      <span
                        className={`status-pill ${template.status === 'ACTIVE' ? 'published' : ''}`}
                      >
                        {template.status}
                      </span>
                    </header>
                    {template.attribute_template_versions.map((version) => (
                      <div className="template-version" key={version.id}>
                        <div>
                          <strong>
                            v{version.version} · {version.name}
                          </strong>
                          <small>
                            {version.attribute_definitions.length} {t.attributes} · {version.status}
                          </small>
                        </div>
                        <div className="definition-chips">
                          {version.attribute_definitions.slice(0, 5).map((definition) => (
                            <span key={definition.code}>{definition.code}</span>
                          ))}
                        </div>
                        {version.status === 'DRAFT' && (
                          <button
                            className="secondary"
                            onClick={() =>
                              setConfirm({
                                code: template.code,
                                description: `${t.activate}: ${template.code} v${version.version}`,
                                label: t.activate,
                                run: () =>
                                  void mutate(
                                    `/v1/admin/catalog/attribute-templates/${template.id}/versions/${version.version}/activate`,
                                    'POST',
                                    { expected_template_version: template.version },
                                  ),
                              })
                            }
                          >
                            {t.activate}
                          </button>
                        )}
                      </div>
                    ))}
                  </article>
                ))}
            </div>
          ) : (
            <p className="empty-state">{t.empty}</p>
          )}
        </div>
      )}

      {section === 'products' && (
        <div className="catalog-panel">
          <div className="panel-title">
            <h3>{t.products}</h3>
            <button className="primary" onClick={() => setProductDialog(true)}>
              + {t.create}
            </button>
          </div>
          {filteredProducts.length ? (
            <div className="product-layout">
              <div className="product-list">
                {filteredProducts.map((product) => (
                  <button
                    className={selectedProduct?.id === product.id ? 'active' : ''}
                    key={product.id}
                    onClick={() => void openProduct(product)}
                  >
                    <span className={`product-dot ${product.status.toLocaleLowerCase()}`} />
                    <div>
                      <strong>{localizedName(product.product_localizations, locale)}</strong>
                      <small>
                        {product.code} · {product.status} · v{product.version}
                      </small>
                      <small>{product.skus.length} SKU</small>
                    </div>
                    <span>›</span>
                  </button>
                ))}
              </div>
              <aside className="product-inspector">
                {selectedProduct ? (
                  <>
                    <header>
                      <div>
                        <p className="eyebrow">{selectedProduct.code}</p>
                        <h3>{localizedName(selectedProduct.product_localizations, locale)}</h3>
                      </div>
                      <span
                        className={`status-pill ${selectedProduct.status === 'PUBLISHED' ? 'published' : ''}`}
                      >
                        {selectedProduct.status}
                      </span>
                    </header>
                    <div className="sku-summary">
                      {selectedProduct.skus.length ? (
                        selectedProduct.skus.map((sku) => (
                          <div key={sku.code}>
                            <span>{sku.code}</span>
                            <strong>
                              {new Intl.NumberFormat(
                                locale === 'vi' ? 'vi-VN' : locale === 'zh' ? 'zh-CN' : 'en-US',
                              ).format(Number(sku.salePriceVnd))}{' '}
                              ₫
                            </strong>
                          </div>
                        ))
                      ) : (
                        <p>{t.empty}</p>
                      )}
                    </div>
                    {editor ? (
                      <AttributeEditorPanel
                        editor={editor}
                        locale={locale}
                        onSave={(values) =>
                          void mutate(
                            `/v1/admin/catalog/products/${selectedProduct.id}/attributes`,
                            'PUT',
                            { expected_version: editor.product_version, values },
                          )
                        }
                      />
                    ) : (
                      <p className="empty-state">{t.loading}</p>
                    )}
                    {issues.length > 0 && (
                      <div className="publication-issues" role="alert">
                        <strong>{t.error}</strong>
                        {issues.map((issue, index) => (
                          <span
                            key={
                              typeof issue === 'string'
                                ? `${issue}:${index}`
                                : `${issue.code}:${issue.reference ?? ''}:${index}`
                            }
                          >
                            {typeof issue === 'string'
                              ? issue
                              : `${issue.code}${issue.reference ? ` · ${issue.reference}` : ''}`}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="product-actions">
                      {['DRAFT', 'UNPUBLISHED'].includes(selectedProduct.status) && (
                        <button
                          className="secondary"
                          onClick={() => void productAction(selectedProduct, 'submit')}
                        >
                          {t.submit}
                        </button>
                      )}
                      {selectedProduct.status === 'PENDING_REVIEW' && (
                        <button
                          className="primary"
                          onClick={() =>
                            setConfirm({
                              code: selectedProduct.code,
                              description: `${t.publish}: ${selectedProduct.code}`,
                              label: t.publish,
                              run: () => void productAction(selectedProduct, 'publish'),
                            })
                          }
                        >
                          {t.publish}
                        </button>
                      )}
                      {!['DISABLED', 'UNPUBLISHED'].includes(selectedProduct.status) && (
                        <button
                          className="danger-button"
                          onClick={() =>
                            setConfirm({
                              code: 'DISABLE',
                              description: `${t.disableProduct}: ${selectedProduct.code}`,
                              label: t.disableProduct,
                              run: () =>
                                void mutate('/v1/admin/catalog/products/batch/disable', 'POST', {
                                  confirmation_code: 'DISABLE',
                                  items: [
                                    {
                                      expected_version: selectedProduct.version,
                                      product_id: selectedProduct.id,
                                    },
                                  ],
                                }),
                            })
                          }
                        >
                          {t.disableProduct}
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="inspector-placeholder">← {t.products}</p>
                )}
              </aside>
            </div>
          ) : (
            <p className="empty-state">{t.empty}</p>
          )}
        </div>
      )}

      {section === 'compliance' && (
        <div className="catalog-panel">
          <div className="panel-title">
            <h3>{t.compliance}</h3>
            <div className="requirement-summary">
              <span>
                {compliance.requirements.length} {t.activeRequirements}
              </span>
              <span>
                {compliance.requirements.filter((item) => item.blocking).length} {t.blocking}
              </span>
            </div>
          </div>
          <div className="requirement-strip" aria-label={t.activeRequirements}>
            {compliance.requirements.map((requirement) => (
              <span className={requirement.blocking ? 'blocking' : ''} key={requirement.id}>
                {requirement.code} · {requirement.document_type} · v{requirement.version}
              </span>
            ))}
          </div>
          {compliance.records.length ? (
            <div className="compliance-list">
              {compliance.records.map((record) => (
                <article key={record.id}>
                  <div className="record-status">
                    <span
                      className={`status-pill ${record.status === 'APPROVED' ? 'published' : ''}`}
                    >
                      {record.status}
                    </span>
                    <small>v{record.version}</small>
                  </div>
                  <div>
                    <h4>{record.product.name_vi}</h4>
                    <p>
                      {record.product.code} · {record.requirement.code} ·{' '}
                      {record.requirement.document_type}
                    </p>
                    <small>
                      {new Intl.DateTimeFormat(
                        locale === 'vi' ? 'vi-VN' : locale === 'zh' ? 'zh-CN' : 'en-US',
                        { dateStyle: 'medium', timeStyle: 'short' },
                      ).format(new Date(record.submitted_at))}{' '}
                      · {record.media_count} {t.files} · {record.document_number_masked ?? '—'}
                    </small>
                  </div>
                  {record.status === 'PENDING_REVIEW' && (
                    <button className="secondary" onClick={() => setReviewRecord(record)}>
                      {t.review}
                    </button>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <p className="empty-state">{t.empty}</p>
          )}
        </div>
      )}

      {brandDialog && (
        <BrandDialog
          brand={brandDialog === 'new' ? undefined : brandDialog}
          close={() => setBrandDialog(undefined)}
          locale={locale}
          save={(path, method, body) => void mutate(path, method, body)}
        />
      )}
      {categoryDialog && (
        <CategoryDialog
          categories={allCategories}
          category={categoryDialog === 'new' ? undefined : categoryDialog}
          close={() => setCategoryDialog(undefined)}
          locale={locale}
          save={(path, method, body) => void mutate(path, method, body)}
        />
      )}
      {templateDialog && (
        <TemplateDialog
          close={() => setTemplateDialog(false)}
          locale={locale}
          save={(path, method, body) => void mutate(path, method, body)}
        />
      )}
      {productDialog && (
        <ProductDialog
          brands={brands}
          categories={allCategories}
          close={() => setProductDialog(false)}
          locale={locale}
          save={(path, method, body) => void mutate(path, method, body)}
        />
      )}
      {confirm && (
        <ConfirmDialog
          action={confirm}
          close={() => setConfirm(undefined)}
          locale={locale}
          run={confirm.run}
        />
      )}
      {reviewRecord && (
        <Dialog title={`${t.review} · ${reviewRecord.requirement.code}`}>
          <form
            className="catalog-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const decision = formString(form, 'decision');
              const phrase = `${decision} ${reviewRecord.requirement.code}`;
              if (formString(form, 'confirmation') !== phrase) return;
              void mutate(`/v1/admin/compliance/records/${reviewRecord.id}/review`, 'POST', {
                decision,
                review_note: form.get('note'),
              });
            }}
          >
            <label>
              {t.status}
              <select name="decision">
                <option value="APPROVED">{t.approve}</option>
                <option value="REJECTED">{t.reject}</option>
              </select>
            </label>
            <label>
              {t.reviewNote}
              <textarea maxLength={2000} minLength={1} name="note" required rows={4} />
            </label>
            <label>
              {t.typeCode}: <strong>APPROVED {reviewRecord.requirement.code}</strong> /{' '}
              <strong>REJECTED {reviewRecord.requirement.code}</strong>
              <input name="confirmation" required />
            </label>
            <div className="dialog-actions">
              <button
                className="secondary"
                onClick={() => setReviewRecord(undefined)}
                type="button"
              >
                {t.cancel}
              </button>
              <button className="primary" type="submit">
                {t.confirm}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}
