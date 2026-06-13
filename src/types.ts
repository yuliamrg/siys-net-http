export const modules = ['orders', 'quotes', 'clients', 'equipment'] as const;
export type ModuleName = (typeof modules)[number];
export type ExportFormat = 'json' | 'csv' | 'xlsx' | 'parquet';

export interface CaptureRecord {
  capturedAt: string;
  pageUrl: string;
  module: ModuleName | 'unknown';
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  contentType?: string;
  requestBody?: unknown;
  responseBodyFile?: string;
  failure?: string;
}

export interface EndpointDefinition {
  module: ModuleName;
  method: 'GET' | 'POST';
  path: string;
  dataPath?: string;
  pagination?: {
    pageParam: string;
    pageSizeParam: string;
    pageSize: number;
    totalPath?: string;
  };
  defaultParams?: Record<string, string>;
}

export interface EndpointInventory {
  generatedAt: string;
  apiBaseUrl: string;
  endpoints: Array<{
    module: ModuleName | 'unknown';
    method: string;
    path: string;
    statuses: number[];
    contentTypes: string[];
    sampleCount: number;
  }>;
}
