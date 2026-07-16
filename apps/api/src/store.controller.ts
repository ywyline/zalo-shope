import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  UnauthorizedException,
} from '@nestjs/common';
import type { PrismaClient } from '@zalo-shop/database';
import { withStoreTransaction } from '@zalo-shop/database';
import { createStoreContext } from '@zalo-shop/domain';
import { randomUUID } from 'node:crypto';

import { AdminService } from './admin/admin.service';
import { AuthService } from './auth/auth.service';
import { DATABASE_CLIENT } from './auth/auth.tokens';

type ResolvedStore = { code: string; default_locale: 'en' | 'vi' | 'zh'; id: string };

function bearer(value: string | undefined): string {
  if (!value?.startsWith('Bearer ')) throw new UnauthorizedException('Bearer token is required');
  return value.slice(7);
}

@Controller('v1/stores')
export class StoreController {
  public constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AdminService) private readonly admin: AdminService,
  ) {}

  @Get('current')
  public async current(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-store-code') storeCode: string | undefined,
    @Headers('x-access-reason') accessReason: string | undefined,
  ): Promise<unknown> {
    if (!storeCode) throw new UnauthorizedException('Store context is required');
    const stores = await this.database.$queryRaw<ResolvedStore[]>`
      SELECT * FROM app_security.resolve_active_store(${storeCode.trim()})
    `;
    const store = stores[0];
    if (!store) throw new ForbiddenException('Access denied');
    const accessToken = bearer(authorization);
    const principal = await this.auth.authenticateAccessToken(accessToken, store.code);
    if (principal.actorType === 'admin') {
      return this.admin.getStoreConfig(
        {
          ...(accessReason === undefined ? {} : { accessReason }),
          accessToken,
          storeCode: store.code,
        },
        store.id,
      );
    }
    if (principal.storeId !== store.id) throw new ForbiddenException('Access denied');
    const context = createStoreContext({
      actor: { id: principal.subjectId, type: 'member' },
      correlationId: randomUUID(),
      locale: store.default_locale,
      storeCode: store.code,
      storeId: store.id,
    });
    return withStoreTransaction(this.database, context, (transaction) =>
      transaction.store.findUniqueOrThrow({
        include: { localizations: true, theme: true },
        where: { id: store.id },
      }),
    );
  }
}
