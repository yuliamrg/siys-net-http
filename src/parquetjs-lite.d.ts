declare module 'parquetjs-lite' {
  export class ParquetSchema {
    constructor(schema: Record<string, { type: string; optional?: boolean }>);
  }

  export class ParquetWriter {
    static openFile(schema: ParquetSchema, file: string): Promise<ParquetWriter>;
    appendRow(row: Record<string, unknown>): Promise<void>;
    close(): Promise<void>;
  }

  const parquet: {
    ParquetSchema: typeof ParquetSchema;
    ParquetWriter: typeof ParquetWriter;
  };
  export default parquet;
}
