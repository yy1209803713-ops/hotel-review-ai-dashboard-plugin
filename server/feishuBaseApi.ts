import { createFeishuBaseClient, type FeishuBaseClient } from './feishuBaseClient';

const DEFAULT_PAGE_SIZE = 100;

export type FeishuBaseApiOptions = {
  baseToken: string;
  authCode?: string;
  fetchImpl?: typeof fetch;
  client?: FeishuBaseClient;
};

export type FeishuBaseApiTable = {
  table_id?: string;
  name?: string;
};

export type FeishuBaseApiField = {
  field_id?: string;
  field_name?: string;
  type?: string | number;
};

type FeishuBaseCreateFieldResponse = FeishuBaseApiField & {
  field?: FeishuBaseApiField;
};

export type FeishuBaseApiRecord = {
  record_id?: string;
  fields?: Record<string, unknown>;
};

export type FeishuBasePagedResponse<T> = {
  items?: T[];
  records?: T[];
  has_more?: boolean;
  page_token?: string;
};

export type FeishuBaseApi = {
  listTablesPage: (params: { pageSize: number; pageToken?: unknown }) => Promise<FeishuBasePagedResponse<FeishuBaseApiTable>>;
  listAllTables: (pageSize?: number) => Promise<FeishuBaseApiTable[]>;
  listFieldsPage: (tableId: string, params: { pageSize: number; pageToken?: unknown }) => Promise<FeishuBasePagedResponse<FeishuBaseApiField>>;
  listAllFields: (tableId: string, pageSize?: number) => Promise<FeishuBaseApiField[]>;
  listRecordsPage: (
    tableId: string,
    params: { viewId?: string; pageSize: number; pageToken?: unknown },
  ) => Promise<FeishuBasePagedResponse<FeishuBaseApiRecord>>;
  createTable: (name: string, fields: unknown[]) => Promise<{ table_id?: string }>;
  createField: (tableId: string, field: unknown) => Promise<{ field_id?: string }>;
  createRecords: (
    tableId: string,
    records: Array<{ fields: Record<string, unknown> }>,
  ) => Promise<{ records?: Array<{ record_id?: string }> }>;
  updateRecords: (
    tableId: string,
    records: Array<{ record_id: string; fields: Record<string, unknown> }>,
  ) => Promise<{ records?: Array<{ record_id?: string }> }>;
  deleteRecords: (
    tableId: string,
    recordIds: string[],
  ) => Promise<{ records?: Array<{ record_id?: string }> }>;
};

export function createFeishuBaseApi(options: FeishuBaseApiOptions): FeishuBaseApi {
  const client = options.client ?? createFeishuBaseClient({
    authCode: requireString(options.authCode, 'authCode is required for Feishu Base API'),
    fetchImpl: options.fetchImpl,
  });
  const baseToken = requireString(options.baseToken, 'baseToken is required for Feishu Base API');

  const encodedBaseToken = encodeURIComponent(baseToken);

  const createPath = (suffix: string): string => {
    if (suffix.startsWith('/')) {
      return `/bitable/v1/apps/${encodedBaseToken}${suffix}`;
    }
    return `/bitable/v1/apps/${encodedBaseToken}/${suffix}`;
  };

  return {
    async listTablesPage(params) {
      const query = createPageParams(params.pageSize, params.pageToken);
      return client.request<FeishuBasePagedResponse<FeishuBaseApiTable>>(`${createPath('/tables')}?${query}`);
    },

    async listAllTables(pageSize = DEFAULT_PAGE_SIZE) {
      return listAllPages((pageToken) => listTablesPage({ pageSize, pageToken }));
    },

    async listFieldsPage(tableId, params) {
      const query = createPageParams(params.pageSize, params.pageToken);
      return client.request<FeishuBasePagedResponse<FeishuBaseApiField>>(
        `${createPath(`/tables/${encodeURIComponent(tableId)}/fields`)}?${query}`,
      );
    },

    async listAllFields(tableId, pageSize = DEFAULT_PAGE_SIZE) {
      return listAllPages((pageToken) => listFieldsPage(tableId, { pageSize, pageToken }));
    },

    async listRecordsPage(tableId, params) {
      const query = createPageParams(params.pageSize, params.pageToken);
      if (params.viewId) {
        query.set('view_id', params.viewId);
      }
      return client.request<FeishuBasePagedResponse<FeishuBaseApiRecord>>(
        `${createPath(`/tables/${encodeURIComponent(tableId)}/records`)}?${query}`,
      );
    },

    async createTable(name, fields) {
      const response = await client.request<{ table_id?: string }>(
        createPath('/tables'),
        {
          method: 'POST',
          body: JSON.stringify({
            table: {
              name,
              fields: fields.map((field) => toOpenApiField(field)),
            },
          }),
        },
      );
      return response;
    },

    async createField(tableId, field) {
      const response = await client.request<FeishuBaseCreateFieldResponse>(
        createPath(`/tables/${encodeURIComponent(tableId)}/fields`),
        {
          method: 'POST',
          body: JSON.stringify(toOpenApiField(field)),
        },
      );
      return normalizeCreateFieldResponse(response);
    },

    async createRecords(tableId, records) {
      return client.request<{ records?: Array<{ record_id?: string }> }>(
        createPath(`/tables/${encodeURIComponent(tableId)}/records/batch_create`),
        {
          method: 'POST',
          body: JSON.stringify({ records }),
        },
      );
    },

    async updateRecords(tableId, records) {
      return client.request<{ records?: Array<{ record_id?: string }> }>(
        createPath(`/tables/${encodeURIComponent(tableId)}/records/batch_update`),
        {
          method: 'POST',
          body: JSON.stringify({ records }),
        },
      );
    },

    async deleteRecords(tableId, recordIds) {
      return client.request<{ records?: Array<{ record_id?: string }> }>(
        createPath(`/tables/${encodeURIComponent(tableId)}/records/batch_delete`),
        {
          method: 'POST',
          body: JSON.stringify({ records: recordIds }),
        },
      );
    },
  };

  function listTablesPage(params: { pageSize: number; pageToken?: unknown }) {
    const query = createPageParams(params.pageSize, params.pageToken);
    return client.request<FeishuBasePagedResponse<FeishuBaseApiTable>>(`${createPath('/tables')}?${query}`);
  }

  function listFieldsPage(tableId: string, params: { pageSize: number; pageToken?: unknown }) {
    const query = createPageParams(params.pageSize, params.pageToken);
    return client.request<FeishuBasePagedResponse<FeishuBaseApiField>>(
      `${createPath(`/tables/${encodeURIComponent(tableId)}/fields`)}?${query}`,
    );
  }
}

function normalizeCreateFieldResponse(response: FeishuBaseCreateFieldResponse): { field_id?: string } {
  return {
    field_id: response.field_id ?? response.field?.field_id,
  };
}

function createPageParams(pageSize: number, pageToken?: unknown): URLSearchParams {
  const params = new URLSearchParams({ page_size: String(pageSize) });
  if (pageToken !== undefined) {
    params.set('page_token', requireString(pageToken, 'pageToken must be a non-empty string'));
  }
  return params;
}

async function listAllPages<T>(requestPage: (pageToken?: string) => Promise<FeishuBasePagedResponse<T>>): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    const page = await requestPage(pageToken);
    items.push(...requireArray(page.records ?? page.items, 'records missing from Feishu OpenAPI paged response'));
    pageToken = page.has_more ? requireString(page.page_token, 'page_token missing while has_more is true') : undefined;
  } while (pageToken);
  return items;
}

function requireArray<T>(value: T[] | undefined | null, message: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(message);
  }
  return value;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(message);
  }
  return value;
}

export type FeishuBaseFieldMetaLike = {
  field_id?: string;
  field_name?: string;
  fieldId?: string;
  fieldName?: string;
};

export function buildFieldMetaIndex<T extends FeishuBaseFieldMetaLike>(fields: T[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const field of fields) {
    const fieldId = field.field_id ?? field.fieldId;
    const fieldName = field.field_name ?? field.fieldName;
    if (fieldId) {
      index.set(fieldId, field);
    }
    if (fieldName) {
      index.set(fieldName, field);
    }
  }
  return index;
}

function toOpenApiField(field: unknown): { field_name: string; type: unknown; property?: Record<string, unknown> } {
  if (!isRecord(field)) {
    throw new Error('Field definition must be an object');
  }
  const name = field.name ?? field.field_name;
  const type = normalizeBitableFieldType(requirePresent(field.type, `field type missing for ${String(name)}`));
  const property = toOpenApiFieldProperty(type, field.style);
  return {
    field_name: requireString(name, 'field name missing while creating table'),
    type,
    ...(property ? { property } : {}),
  };
}

function toOpenApiFieldProperty(type: unknown, style: unknown): Record<string, unknown> | undefined {
  if (!isRecord(style)) {
    return undefined;
  }
  if (type === 5 && typeof style.format === 'string') {
    return { date_formatter: style.format };
  }
  if (type === 2) {
    return Object.fromEntries(
      Object.entries({
        formatter: '0',
        precision: style.precision,
        comma_style: style.thousands_separator,
      }).filter(([, value]) => value !== undefined),
    );
  }
  return undefined;
}

function normalizeBitableFieldType(type: unknown): unknown {
  if (typeof type !== 'string') {
    return type;
  }
  switch (type) {
    case 'text':
      return 1;
    case 'number':
      return 2;
    case 'datetime':
      return 5;
    default:
      return type;
  }
}

function requirePresent<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
