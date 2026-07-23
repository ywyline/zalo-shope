export type AddressFields = Readonly<{
  provinceCode: string;
  districtCode: string;
  wardCode: string;
  detail: string;
}>;

export class AddressValidationError extends Error {
  public constructor(public readonly code: 'ADDRESS_INVALID') {
    super(code);
    this.name = 'AddressValidationError';
  }
}

export function normalizeAddressFields(input: AddressFields): AddressFields {
  const normalized = {
    detail: input.detail.trim().replace(/\s+/g, ' '),
    districtCode: input.districtCode.trim().toLowerCase(),
    provinceCode: input.provinceCode.trim().toLowerCase(),
    wardCode: input.wardCode.trim().toLowerCase(),
  };
  if (
    !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(normalized.provinceCode) ||
    !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(normalized.districtCode) ||
    !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(normalized.wardCode) ||
    normalized.detail.length < 3 ||
    normalized.detail.length > 500
  ) {
    throw new AddressValidationError('ADDRESS_INVALID');
  }
  return Object.freeze(normalized);
}

export function isRemoteProvince(
  provinceCode: string,
  remoteProvinceCodes: readonly string[],
): boolean {
  return remoteProvinceCodes.includes(provinceCode.trim().toLowerCase());
}
