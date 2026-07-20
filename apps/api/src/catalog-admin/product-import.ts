import {
  catalogCodeSchema,
  createProductDraftSchema,
  skuDraftSchema,
  type CreateProductDraftInput,
  type SkuDraftInput,
} from '@zalo-shop/contracts';

export const PRODUCT_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const PRODUCT_IMPORT_MAX_ROWS = 2_000;

export const PRODUCT_IMPORT_COLUMNS = [
  'product_code',
  'brand_code',
  'main_category_code',
  'secondary_category_codes',
  'name_vi',
  'selling_points_vi',
  'description_vi',
  'name_zh',
  'selling_points_zh',
  'description_zh',
  'name_en',
  'selling_points_en',
  'description_en',
  'sku_code',
  'barcode',
  'sale_price_vnd',
  'market_price_vnd',
  'cost_price_vnd',
  'weight_grams',
  'sku_options',
] as const;

type ProductImportColumn = (typeof PRODUCT_IMPORT_COLUMNS)[number];

export type ProductImportIssue = {
  code: 'COLUMN_COUNT_INVALID' | 'FIELD_INVALID';
  field?: ProductImportColumn;
  message: string;
};

export type ParsedProductImportRow = {
  issues: ProductImportIssue[];
  line: number;
  product?: {
    brandCode: string;
    create: Omit<CreateProductDraftInput, 'brand_id' | 'main_category_id'>;
    mainCategoryCode: string;
    secondaryCategoryCodes: string[];
  };
  productCode: string;
  sku?: SkuDraftInput;
};

export type ProductImportRecord = { line: number; values: string[] };

export class ProductImportFileError extends Error {
  public constructor(
    public readonly code:
      | 'CELL_INVALID'
      | 'COLUMN_LIMIT_EXCEEDED'
      | 'CSV_INVALID'
      | 'ENCODING_INVALID'
      | 'FILE_EMPTY'
      | 'FILE_TOO_LARGE'
      | 'FORMULA_NOT_ALLOWED'
      | 'HEADER_INVALID'
      | 'ROW_LIMIT_EXCEEDED'
      | 'WORKBOOK_INVALID'
      | 'WORKSHEET_INVALID'
      | 'ZIP_LIMIT_EXCEEDED',
    message: string,
  ) {
    super(message);
    this.name = 'ProductImportFileError';
  }
}

function readUtf8(buffer: Buffer): string {
  if (buffer.byteLength === 0) {
    throw new ProductImportFileError('FILE_EMPTY', 'CSV file is empty');
  }
  if (buffer.byteLength > PRODUCT_IMPORT_MAX_BYTES) {
    throw new ProductImportFileError('FILE_TOO_LARGE', 'CSV file exceeds 2 MiB');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    throw new ProductImportFileError('ENCODING_INVALID', 'CSV file must be valid UTF-8');
  }
}

function parseCsv(text: string): ProductImportRecord[] {
  if (text.includes('\0')) {
    throw new ProductImportFileError('CSV_INVALID', 'CSV contains a NUL control character');
  }
  const records: ProductImportRecord[] = [];
  let field = '';
  let inQuotes = false;
  let justClosedQuote = false;
  let line = 1;
  let recordLine = 1;
  let row: string[] = [];

  const finishField = () => {
    row.push(field);
    field = '';
    justClosedQuote = false;
  };
  const finishRecord = () => {
    finishField();
    if (row.some((value) => value.length > 0)) records.push({ line: recordLine, values: row });
    row = [];
    recordLine = line + 1;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          justClosedQuote = true;
        }
      } else {
        field += character;
        if (character === '\n') line += 1;
      }
      continue;
    }
    if (justClosedQuote && character !== ',' && character !== '\r' && character !== '\n') {
      throw new ProductImportFileError(
        'CSV_INVALID',
        `Unexpected character after closing quote at line ${line}`,
      );
    }
    if (character === '"') {
      if (field.length > 0 || justClosedQuote) {
        throw new ProductImportFileError('CSV_INVALID', `Unexpected quote at line ${line}`);
      }
      inQuotes = true;
    } else if (character === ',') {
      finishField();
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      finishRecord();
      line += 1;
    } else {
      field += character;
    }
  }
  if (inQuotes) {
    throw new ProductImportFileError('CSV_INVALID', `Unclosed quoted field at line ${line}`);
  }
  if (field.length > 0 || row.length > 0 || justClosedQuote) finishRecord();
  return records;
}

function splitCodes(
  value: string,
  field: ProductImportColumn,
  issues: ProductImportIssue[],
): string[] {
  if (value.trim() === '') return [];
  const parsed = value.split('|').map((item) => catalogCodeSchema.safeParse(item));
  const values = parsed.flatMap((item) => (item.success ? [item.data] : []));
  if (values.length !== parsed.length || new Set(values).size !== values.length) {
    issues.push({
      code: 'FIELD_INVALID',
      field,
      message: `${field} contains invalid or duplicate codes`,
    });
    return [];
  }
  return values;
}

function optionalInteger(
  value: string,
  field: ProductImportColumn,
  issues: ProductImportIssue[],
  positive = false,
): number | null {
  if (value.trim() === '') return null;
  if (!/^(0|[1-9]\d*)$/.test(value.trim())) {
    issues.push({ code: 'FIELD_INVALID', field, message: `${field} must be an integer` });
    return null;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (positive ? number <= 0 : number < 0)) {
    issues.push({ code: 'FIELD_INVALID', field, message: `${field} is outside the allowed range` });
    return null;
  }
  return number;
}

function requiredInteger(
  value: string,
  field: ProductImportColumn,
  issues: ProductImportIssue[],
): number {
  const parsed = optionalInteger(value, field, issues);
  if (parsed === null && value.trim() === '') {
    issues.push({ code: 'FIELD_INVALID', field, message: `${field} is required` });
  }
  return parsed ?? 0;
}

function localizations(values: Record<ProductImportColumn, string>, issues: ProductImportIssue[]) {
  const result: CreateProductDraftInput['localizations'] = [];
  for (const locale of ['vi', 'zh', 'en'] as const) {
    const nameField = `name_${locale}` as ProductImportColumn;
    const sellingPointsField = `selling_points_${locale}` as ProductImportColumn;
    const descriptionField = `description_${locale}` as ProductImportColumn;
    const name = values[nameField].trim();
    const sellingPoints = values[sellingPointsField].trim();
    const description = values[descriptionField].trim();
    if (locale !== 'vi' && name === '' && sellingPoints === '' && description === '') continue;
    if (name === '') {
      issues.push({ code: 'FIELD_INVALID', field: nameField, message: `${nameField} is required` });
      continue;
    }
    result.push({
      description: description === '' ? null : description,
      locale,
      name,
      selling_points: sellingPoints === '' ? null : sellingPoints,
    });
  }
  return result;
}

function skuOptions(value: string, issues: ProductImportIssue[]) {
  const selections = value.split('|').map((item) => item.trim());
  if (value.trim() === '' || selections.some((item) => item === '')) {
    issues.push({
      code: 'FIELD_INVALID',
      field: 'sku_options',
      message: 'sku_options is required',
    });
    return [];
  }
  const result = selections.flatMap((selection) => {
    const separator = selection.indexOf('=');
    if (separator <= 0 || separator !== selection.lastIndexOf('=')) {
      issues.push({
        code: 'FIELD_INVALID',
        field: 'sku_options',
        message: 'sku_options must use attribute_code=option_code pairs',
      });
      return [];
    }
    const attributeCode = catalogCodeSchema.safeParse(selection.slice(0, separator));
    const optionCode = catalogCodeSchema.safeParse(selection.slice(separator + 1));
    if (!attributeCode.success || !optionCode.success) {
      issues.push({
        code: 'FIELD_INVALID',
        field: 'sku_options',
        message: 'sku_options contains an invalid business code',
      });
      return [];
    }
    return [{ attribute_code: attributeCode.data, option_code: optionCode.data }];
  });
  return result;
}

function parseDataRecord(record: ProductImportRecord): ParsedProductImportRow {
  const issues: ProductImportIssue[] = [];
  if (record.values.length !== PRODUCT_IMPORT_COLUMNS.length) {
    return {
      issues: [
        {
          code: 'COLUMN_COUNT_INVALID',
          message: `Expected ${PRODUCT_IMPORT_COLUMNS.length} columns but received ${record.values.length}`,
        },
      ],
      line: record.line,
      productCode: record.values[0]?.trim() ?? '',
    };
  }
  const values = Object.fromEntries(
    PRODUCT_IMPORT_COLUMNS.map((column, index) => [column, record.values[index] ?? '']),
  ) as Record<ProductImportColumn, string>;
  const normalizedCodes = new Map<ProductImportColumn, string>();
  for (const [field, value] of [
    ['product_code', values.product_code],
    ['brand_code', values.brand_code],
    ['main_category_code', values.main_category_code],
    ['sku_code', values.sku_code],
  ] as const) {
    const parsed = catalogCodeSchema.safeParse(value);
    if (!parsed.success) {
      issues.push({ code: 'FIELD_INVALID', field, message: `${field} is invalid` });
    } else {
      normalizedCodes.set(field, parsed.data);
    }
  }
  const productCode = normalizedCodes.get('product_code') ?? values.product_code.trim();
  const brandCode = normalizedCodes.get('brand_code') ?? values.brand_code.trim();
  const mainCategoryCode =
    normalizedCodes.get('main_category_code') ?? values.main_category_code.trim();
  const skuCode = normalizedCodes.get('sku_code') ?? values.sku_code.trim();
  const secondaryCategoryCodes = splitCodes(
    values.secondary_category_codes,
    'secondary_category_codes',
    issues,
  );
  if (secondaryCategoryCodes.includes(mainCategoryCode)) {
    issues.push({
      code: 'FIELD_INVALID',
      field: 'secondary_category_codes',
      message: 'Main category cannot also be secondary',
    });
  }
  const productLocalizations = localizations(values, issues);
  const salePriceVnd = requiredInteger(values.sale_price_vnd, 'sale_price_vnd', issues);
  const marketPriceVnd = optionalInteger(values.market_price_vnd, 'market_price_vnd', issues);
  const costPriceVnd = optionalInteger(values.cost_price_vnd, 'cost_price_vnd', issues);
  const weightGrams = optionalInteger(values.weight_grams, 'weight_grams', issues, true);
  const optionValues = skuOptions(values.sku_options, issues);
  const productCreate = createProductDraftSchema.safeParse({
    brand_id: '00000000-0000-4000-8000-000000000000',
    code: productCode,
    localizations: productLocalizations,
    main_category_id: '00000000-0000-4000-8000-000000000000',
    secondary_category_ids: [],
  });
  if (!productCreate.success) {
    issues.push({ code: 'FIELD_INVALID', message: 'Product content is invalid' });
  }
  const parsedSku = skuDraftSchema.safeParse({
    barcode: values.barcode.trim() === '' ? null : values.barcode.trim(),
    code: skuCode,
    cost_price_vnd: costPriceVnd,
    enabled: true,
    market_price_vnd: marketPriceVnd,
    option_values: optionValues,
    sale_price_vnd: salePriceVnd,
    weight_grams: weightGrams,
  });
  if (!parsedSku.success) {
    issues.push({ code: 'FIELD_INVALID', message: 'SKU content is invalid' });
  }
  if (issues.length > 0 || !productCreate.success || !parsedSku.success) {
    return { issues, line: record.line, productCode };
  }
  return {
    issues: [],
    line: record.line,
    product: {
      brandCode,
      create: {
        code: productCreate.data.code,
        localizations: productCreate.data.localizations,
        secondary_category_ids: [],
      },
      mainCategoryCode,
      secondaryCategoryCodes,
    },
    productCode,
    sku: parsedSku.data,
  };
}

export function parseProductImportCsv(buffer: Buffer): ParsedProductImportRow[] {
  const records = parseCsv(readUtf8(buffer));
  return parseProductImportRecords(records, 'CSV');
}

export function parseProductImportRecords(
  records: ProductImportRecord[],
  format: 'CSV' | 'XLSX',
): ParsedProductImportRow[] {
  const header = records[0];
  if (!header) throw new ProductImportFileError('FILE_EMPTY', `${format} file has no header`);
  if (
    header.values.length !== PRODUCT_IMPORT_COLUMNS.length ||
    header.values.some((value, index) => value.trim() !== PRODUCT_IMPORT_COLUMNS[index])
  ) {
    throw new ProductImportFileError(
      'HEADER_INVALID',
      `${format} header does not match the template`,
    );
  }
  const data = records.slice(1);
  if (data.length === 0) {
    throw new ProductImportFileError('FILE_EMPTY', `${format} file has no data rows`);
  }
  if (data.length > PRODUCT_IMPORT_MAX_ROWS) {
    throw new ProductImportFileError(
      'ROW_LIMIT_EXCEEDED',
      `${format} exceeds ${PRODUCT_IMPORT_MAX_ROWS} data rows`,
    );
  }
  return data.map(parseDataRecord);
}

export function productImportTemplateCsv(): Buffer {
  return Buffer.from(`\uFEFF${PRODUCT_IMPORT_COLUMNS.join(',')}\r\n`, 'utf8');
}
