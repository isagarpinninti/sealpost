import { diskStorage, type Storage } from "./storage";
import { buildLedgerRecord, verifyDeliveryLedger, type DeliveryLedgerRecord, type DeliveryReceipt, type LedgerVerification } from "@sealpost/core";

/** Reads the JSONL ledger. Returns records newest first. A corrupt line is reported, never skipped. */
export async function readLedger(path: string, storage: Storage = diskStorage): Promise<DeliveryLedgerRecord[]> {
  let text: string;
  try {
    text = await storage.readText(path);
  } catch {
    return [];
  }
  const out: DeliveryLedgerRecord[] = [];
  text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .forEach((line, i) => {
      try {
        out.push(JSON.parse(line) as DeliveryLedgerRecord);
      } catch {
        throw new Error(`Ledger line ${i + 1} is not valid JSON — the file was modified outside Sealpost.`);
      }
    });
  return out.reverse();
}

/** Serialises appends within the process so the hash chain never forks. */
export class LedgerWriter {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly path: string,
    private readonly storage: Storage = diskStorage,
  ) {}

  append(receipt: DeliveryReceipt): Promise<DeliveryLedgerRecord> {
    const run = async (): Promise<DeliveryLedgerRecord> => {
      const current = await readLedger(this.path, this.storage);
      const record = await buildLedgerRecord(current[0], receipt);
      await this.storage.appendText(this.path, `${JSON.stringify(record)}\n`, 0o600);
      return record;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

export async function verifyLedgerFile(path: string, storage: Storage = diskStorage): Promise<LedgerVerification> {
  return verifyDeliveryLedger((await readLedger(path, storage)).reverse());
}
