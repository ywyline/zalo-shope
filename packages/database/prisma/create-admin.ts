import { PrismaClient } from '@prisma/client';
import { encryptSensitive, hashPassword } from '@zalo-shop/security';

async function createAdmin(): Promise<void> {
  if (!['development', 'test'].includes(process.env.NODE_ENV ?? '')) {
    throw new Error('Local admin bootstrap is restricted to development and test');
  }
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const displayName = process.env.ADMIN_BOOTSTRAP_DISPLAY_NAME?.trim();
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  const totpSecret = process.env.ADMIN_BOOTSTRAP_TOTP_SECRET;
  const encryptionKey = process.env.PII_ENCRYPTION_KEY;
  if (!email || !displayName || !password || !totpSecret || !encryptionKey) {
    throw new Error('Admin bootstrap environment is incomplete');
  }

  const client = new PrismaClient();
  try {
    await client.adminUser.create({
      data: {
        displayName,
        email,
        emailNormalized: email,
        mfaEnabled: true,
        mfaSecretCiphertext: encryptSensitive(totpSecret, encryptionKey),
        passwordHash: await hashPassword(password),
      },
    });
  } finally {
    await client.$disconnect();
  }
}

void createAdmin();
