import 'dotenv/config';

import { PrismaClient } from '@prisma/client';

type EvidencePreflightCounts = Readonly<{
  evidence_files: bigint;
  evidence_idempotency_records: bigint;
  evidence_outbox_messages: bigint;
  evidence_transitions: bigint;
}>;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for the read-only B2b-D0 preflight');
  }

  const database = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const counts = await database.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SET TRANSACTION READ ONLY`;
        // PostgreSQL rejects an RLS-filtered query when row_security is off. A
        // runtime URL therefore cannot turn hidden rows into a false empty PASS.
        await transaction.$executeRaw`SET LOCAL row_security = off`;
        const rows = await transaction.$queryRaw<EvidencePreflightCounts[]>`
          SELECT
            (SELECT pg_catalog.count(*) FROM after_sale_evidence_files)
              AS evidence_files,
            (SELECT pg_catalog.count(*) FROM after_sale_evidence_transitions)
              AS evidence_transitions,
            (SELECT pg_catalog.count(*) FROM outbox_messages
              WHERE aggregate_type = 'AFTER_SALE_EVIDENCE'
                 OR event_type LIKE 'after-sale.evidence.%')
              AS evidence_outbox_messages,
            (SELECT pg_catalog.count(*) FROM idempotency_records
              WHERE operation LIKE 'after-sale-evidence-%')
              AS evidence_idempotency_records
        `;
        const result = rows[0];
        if (!result) throw new Error('B2b-D0 preflight count query returned no row');
        return result;
      },
      { isolationLevel: 'RepeatableRead', maxWait: 10_000, timeout: 30_000 },
    );

    const total =
      counts.evidence_files +
      counts.evidence_transitions +
      counts.evidence_outbox_messages +
      counts.evidence_idempotency_records;
    if (total !== 0n) {
      throw new Error(
        'M6.3-B2b-D0 compatibility preflight failed: existing evidence runtime facts ' +
          `files=${counts.evidence_files.toString()} ` +
          `transitions=${counts.evidence_transitions.toString()} ` +
          `outbox=${counts.evidence_outbox_messages.toString()} ` +
          `idempotency=${counts.evidence_idempotency_records.toString()}`,
      );
    }

    process.stdout.write(
      'M6.3-B2b-D0 compatibility preflight PASS ' +
        '(files=0, transitions=0, outbox=0, idempotency=0)\n',
    );
  } finally {
    await database.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'B2b-D0 preflight failed'}\n`);
  process.exitCode = 1;
});
