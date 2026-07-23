import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type EvidenceReservation = Readonly<{
  environment: string;
  executionId: string;
  kind: 'http' | 'storage';
  outputPath: string;
  runId: string;
  startedAt: string;
}>;

export async function reserveEvidence(
  kind: EvidenceReservation['kind'],
  runId: string,
  environment: string,
): Promise<EvidenceReservation> {
  const executionId = randomUUID();
  const startedAt = new Date().toISOString();
  const outputDirectory = path.resolve('test-results', 'readiness', kind);
  const outputPath = path.join(outputDirectory, `${runId}-${executionId}.json`);
  const reservation = { environment, executionId, kind, outputPath, runId, startedAt } as const;
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        environment,
        execution_id: executionId,
        kind,
        passed: null,
        run_id: runId,
        started_at: startedAt,
        status: 'started',
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
  return reservation;
}

export async function finalizeEvidence(
  reservation: EvidenceReservation,
  report: Readonly<Record<string, unknown>>,
): Promise<void> {
  await writeFile(
    reservation.outputPath,
    `${JSON.stringify(
      {
        ...report,
        execution_id: reservation.executionId,
        status: report.passed === true ? 'passed' : 'failed',
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', flag: 'w' },
  );
}

export async function recordFailedEvidence(
  reservation: EvidenceReservation,
  failure: string,
): Promise<void> {
  await finalizeEvidence(reservation, {
    environment: reservation.environment,
    failure,
    finished_at: new Date().toISOString(),
    kind: reservation.kind,
    passed: false,
    run_id: reservation.runId,
    started_at: reservation.startedAt,
  });
}
