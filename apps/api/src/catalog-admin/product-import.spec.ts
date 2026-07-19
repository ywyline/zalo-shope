import { describe, expect, it } from 'vitest';

import {
  PRODUCT_IMPORT_COLUMNS,
  PRODUCT_IMPORT_MAX_BYTES,
  PRODUCT_IMPORT_MAX_ROWS,
  ProductImportFileError,
  parseProductImportCsv,
  productImportTemplateCsv,
} from './product-import';

function csvRow(overrides: Partial<Record<(typeof PRODUCT_IMPORT_COLUMNS)[number], string>> = {}) {
  const values: Record<(typeof PRODUCT_IMPORT_COLUMNS)[number], string> = {
    barcode: '893000000001',
    brand_code: 'lotus',
    cost_price_vnd: '90000',
    description_en: '',
    description_vi: 'Mô tả',
    description_zh: '',
    main_category_code: 'serum',
    market_price_vnd: '150000',
    name_en: '',
    name_vi: 'Tinh chất',
    name_zh: '',
    product_code: 'serum-01',
    sale_price_vnd: '120000',
    secondary_category_codes: '',
    selling_points_en: '',
    selling_points_vi: 'Dịu nhẹ',
    selling_points_zh: '',
    sku_code: 'serum-01-30ml',
    sku_options: 'capacity=ml30',
    weight_grams: '120',
    ...overrides,
  };
  return PRODUCT_IMPORT_COLUMNS.map((column) => {
    const value = values[column];
    return value.includes(',') || value.includes('"') ? `"${value.replaceAll('"', '""')}"` : value;
  }).join(',');
}

function file(...rows: string[]) {
  return Buffer.from(`${PRODUCT_IMPORT_COLUMNS.join(',')}\r\n${rows.join('\r\n')}\r\n`);
}

describe('M2.7 product CSV import parser', () => {
  it('generates an Excel-friendly UTF-8 template with the frozen columns', () => {
    const template = productImportTemplateCsv();
    expect(template.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(template.toString('utf8')).toContain(PRODUCT_IMPORT_COLUMNS.join(','));
  });

  it('parses quoted Vietnamese text, escaped quotes and integer VND without evaluating cells', () => {
    const [row] = parseProductImportCsv(
      file(
        csvRow({
          description_vi: 'Không hương liệu, dùng "mỗi ngày"',
          name_vi: '=Không phải công thức, serum',
        }),
      ),
    );
    expect(row).toMatchObject({
      issues: [],
      line: 2,
      product: {
        brandCode: 'lotus',
        create: { localizations: [{ locale: 'vi', name: '=Không phải công thức, serum' }] },
        mainCategoryCode: 'serum',
      },
      productCode: 'serum-01',
      sku: { sale_price_vnd: 120000, weight_grams: 120 },
    });
  });

  it('returns row issues for invalid fields while keeping other rows reportable', () => {
    const rows = parseProductImportCsv(
      file(
        csvRow({ product_code: 'INVALID CODE', sale_price_vnd: '12.5' }),
        csvRow({ product_code: 'valid-02', sku_code: 'valid-02-30ml' }),
      ),
    );
    expect(rows[0]?.issues.map((issue) => issue.field)).toEqual(
      expect.arrayContaining(['product_code', 'sale_price_vnd']),
    );
    expect(rows[1]).toMatchObject({ issues: [], productCode: 'valid-02' });
  });

  it.each([
    ['invalid UTF-8', Buffer.from([0xff, 0xfe, 0xfd]), 'ENCODING_INVALID'],
    ['missing data rows', Buffer.from(`${PRODUCT_IMPORT_COLUMNS.join(',')}\n`), 'FILE_EMPTY'],
    ['unexpected header', Buffer.from('product_code,inventory\nitem,3\n'), 'HEADER_INVALID'],
    ['unclosed quote', Buffer.from(`${PRODUCT_IMPORT_COLUMNS.join(',')}\n"broken`), 'CSV_INVALID'],
    ['oversized file', Buffer.alloc(PRODUCT_IMPORT_MAX_BYTES + 1, 0x61), 'FILE_TOO_LARGE'],
  ])('rejects a file-level %s error', (_label, input, code) => {
    try {
      parseProductImportCsv(input);
      expect.fail('Expected a product import file error');
    } catch (error) {
      expect(error).toBeInstanceOf(ProductImportFileError);
      expect((error as ProductImportFileError).code).toBe(code);
    }
  });

  it('rejects more than the bounded number of data rows', () => {
    const row = csvRow();
    try {
      parseProductImportCsv(
        file(...Array.from({ length: PRODUCT_IMPORT_MAX_ROWS + 1 }, () => row)),
      );
      expect.fail('Expected a row limit error');
    } catch (error) {
      expect(error).toBeInstanceOf(ProductImportFileError);
      expect((error as ProductImportFileError).code).toBe('ROW_LIMIT_EXCEEDED');
    }
  });
});
