import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  LegacyOrderRecord,
  reconcileLegacyOrders,
} from '../src/orders/order-reconciliation';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const input = option('--input');
  const output = option('--output');
  if (!input) {
    throw new Error(
      'Usage: npm run reconcile:orders -- --input <export.json> [--output <report.json>]',
    );
  }

  const raw = JSON.parse(await readFile(resolve(input), 'utf8')) as
    | LegacyOrderRecord[]
    | { data?: LegacyOrderRecord[] };
  const orders = Array.isArray(raw) ? raw : raw.data;
  if (!Array.isArray(orders)) {
    throw new Error(
      'Input must be a JSON array or an object with a data array.',
    );
  }

  const report = `${JSON.stringify(reconcileLegacyOrders(orders), null, 2)}\n`;
  if (output) {
    await writeFile(resolve(output), report, 'utf8');
    return;
  }
  process.stdout.write(report);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
