import type { DatabaseSync } from "node:sqlite";

interface HighWaterRow {
  readonly position: number;
}

export class EventLedgerReader {
  public constructor(private readonly database: DatabaseSync) {}

  public highWaterPosition(): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(position), 0) AS position FROM events")
      .get() as unknown as HighWaterRow;
    return row.position;
  }
}
