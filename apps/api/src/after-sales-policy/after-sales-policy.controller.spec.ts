import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AfterSalesPolicyController } from './after-sales-policy.controller';
import type { AfterSalesPolicyService } from './after-sales-policy.service';

const STORE_ID = '10000000-0000-4000-8000-000000000001';
const CORRELATION_ID = 'settings-correlation-123';

function fixture() {
  const body = {
    current_version_number: null,
    default_policy_code: null,
    enforce_policy_snapshots: false,
    readiness_checked_at: null,
    readiness_state: 'NOT_READY' as const,
    version: 1,
  };
  const getSettings = vi.fn().mockResolvedValue(body);
  const setEnforcement = vi.fn().mockResolvedValue({ body, replayed: true });
  const controller = new AfterSalesPolicyController({
    getSettings,
    setEnforcement,
  } as unknown as AfterSalesPolicyService);
  const setHeader = vi.fn();
  return { body, controller, getSettings, setEnforcement, setHeader };
}

describe('AfterSalesPolicyController response security metadata', () => {
  it('strictly parses settings reads and propagates private correlation metadata', async () => {
    const { body, controller, getSettings, setHeader } = fixture();
    await expect(
      controller.getSettings(
        { store_id: STORE_ID },
        'Bearer admin-token',
        'beauty-local',
        'Operational policy review',
        CORRELATION_ID,
        {},
        { setHeader },
      ),
    ).resolves.toEqual(body);
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(setHeader).toHaveBeenCalledWith('X-Correlation-Id', CORRELATION_ID);
    expect(getSettings).toHaveBeenCalledWith(
      {
        accessReason: 'Operational policy review',
        accessToken: 'admin-token',
        correlationId: CORRELATION_ID,
        storeCode: 'beauty-local',
      },
      STORE_ID,
    );

    expect(() =>
      controller.getSettings(
        { extra: 'rejected', store_id: STORE_ID },
        'Bearer admin-token',
        'beauty-local',
        undefined,
        CORRELATION_ID,
        {},
        { setHeader },
      ),
    ).toThrow(BadRequestException);
  });

  it('returns the settings idempotency and correlation headers on writes', async () => {
    const { body, controller, setEnforcement, setHeader } = fixture();
    await expect(
      controller.setEnforcement(
        { store_id: STORE_ID },
        'Bearer admin-token',
        'settings-idempotency-key',
        'beauty-local',
        undefined,
        CORRELATION_ID,
        {
          confirmation_code: 'DISABLE_AFTER_SALE_POLICY_ENFORCEMENT',
          enabled: false,
          expected_version: 1,
          reason: 'Disable enforcement for a reviewed rollback',
        },
        {},
        { setHeader },
      ),
    ).resolves.toEqual(body);
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(setHeader).toHaveBeenCalledWith('X-Correlation-Id', CORRELATION_ID);
    expect(setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'true');
    expect(setEnforcement).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: CORRELATION_ID }),
      STORE_ID,
      'settings-idempotency-key',
      expect.objectContaining({ enabled: false, expected_version: 1 }),
    );
  });
});
