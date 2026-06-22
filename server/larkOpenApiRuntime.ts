import { createFeishuBaseClient, type FeishuBaseClient } from './feishuBaseClient';

export type LarkOpenApiRuntimeOptions = {
  baseToken: string;
  authCode?: string;
  fetchImpl?: typeof fetch;
  client?: FeishuBaseClient;
};

export type RuntimeTable = {
  tableId: string;
  tableName: string;
};

export type RuntimeCategory = {
  fieldId: string;
  fieldName: string;
  fieldType: string | number;
};

export type RecordsPage = {
  records: Array<{
    recordId: string;
    fields: Record<string, unknown>;
  }>;
  hasMore: boolean;
  pageToken?: unknown;
};

export type LarkOpenApiRuntime = {
  getTableList(): Promise<RuntimeTable[]>;
  getFieldMetaList(tableId: string): Promise<RuntimeCategory[]>;
  clearFieldMetaCache(tableId?: string): void;
  readRecordsPage(tableId: string, params: { viewId?: string; pageSize: number; pageToken?: unknown }): Promise<RecordsPage>;
  addTable(name: string, fields: unknown[]): Promise<{ tableId: string }>;
  addRecords(tableId: string, records: Array<{ fields: Record<string, unknown> }>): Promise<string[]>;
  setRecords(tableId: string, records: Array<{ recordId: string; fields: Record<string, unknown> }>): Promise<Array<{ recordId: string }>>;
};

const FIELD_META_CACHE_TTL_MS = 5 * 60 * 1000;

export function createLarkOpenApiRuntime(options: LarkOpenApiRuntimeOptions): LarkOpenApiRuntime {
  const client = options.client ?? createFeishuBaseClient({ authCode: requireString(options.authCode, 'authCode is required for Feishu Base runtime'), fetchImpl: options.fetchImpl });
  const fieldCache = new Map<string, FieldMetaCacheEntry>();

  const clearFieldMetaCache = (tableId?: string): void => {
    if (tableId) {
      fieldCache.delete(tableId);
      return;
    }
    fieldCache.clear();
  };

  const openApiRequest = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    return client.request<T>(path, init);
  };

  const getFieldMetaList = (tableId: string): Promise<RuntimeCategory[]> => {
    const cached = fieldCache.get(tableId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.promise;
    }
    fieldCache.delete(tableId);

    const fieldsPromise = listAllPages<OpenApiField>((pageToken) => {
      const params = createPageParams(100, pageToken);
      return openApiRequest(`/bitable/v1/apps/${encodeURIComponent(options.baseToken)}/tables/${encodeURIComponent(tableId)}/fields?${params}`);
    })
      .then((items) =>
        items.map((field) => ({
          fieldId: requireString(field.field_id, `field_id missing for table ${tableId}`),
          fieldName: requireString(field.field_name, `field_name missing for table ${tableId}`),
          fieldType: requirePresent(field.type, `type missing for field ${field.field_id}`),
        })),
      )
      .catch((error) => {
        fieldCache.delete(tableId);
        throw error;
      });

    fieldCache.set(tableId, { promise: fieldsPromise, expiresAt: Date.now() + FIELD_META_CACHE_TTL_MS });
    return fieldsPromise;
  };

  const toFieldNames = async (tableId: string, fields: Record<string, unknown>) => {
    const fieldMetaByKey = buildFieldMetaIndex(await getFieldMetaList(tableId));
    return Object.fromEntries(
      Object.entries(fields).map(([fieldKey, value]) => {
        const fieldMeta = fieldMetaByKey.get(fieldKey);
        if (!fieldMeta) {
          clearFieldMetaCache(tableId);
          throw new Error(`Field ${fieldKey} not found in table ${tableId}`);
        }
        return [fieldMeta.fieldName, value];
      }),
    );
  };

  const runtime: LarkOpenApiRuntime = {
    async getTableList(): Promise<RuntimeTable[]> {
      const tables = await listAllPages<OpenApiTable>((pageToken) => {
        const params = createPageParams(100, pageToken);
        return openApiRequest(`/bitable/v1/apps/${encodeURIComponent(options.baseToken)}/tables?${params}`);
      });

      return tables.map((table) => ({
        tableId: requireString(table.table_id, 'table_id missing in Base table list'),
        tableName: requireString(table.name, `name missing for table ${table.table_id}`),
      }));
    },

    getFieldMetaList,

    clearFieldMetaCache(tableId?: string) {
      clearFieldMetaCache(tableId);
    },

    async readRecordsPage(tableId: string, params: { viewId?: string; pageSize: number; pageToken?: unknown }): Promise<RecordsPage> {
      const searchParams = createPageParams(params.pageSize, params.pageToken);
      if (params.viewId) {
        searchParams.set('view_id', params.viewId);
      }
      const [fields, page] = await Promise.all([
        getFieldMetaList(tableId),
        openApiRequest<{ items?: OpenApiRecord[]; has_more?: boolean; page_token?: string }>(
          `/bitable/v1/apps/${encodeURIComponent(options.baseToken)}/tables/${encodeURIComponent(tableId)}/records?${searchParams}`,
        ),
      ]);
      const fieldMetaByKey = buildFieldMetaIndex(fields);

      return {
        records: requireArray(page.items, `items missing from records response for table ${tableId}`).map((record) => {
          const sourceFields = record.fields ?? {};
          const mappedFields: Record<string, unknown> = { ...sourceFields };
          for (const [fieldName, value] of Object.entries(sourceFields)) {
            const fieldMeta = fieldMetaByKey.get(fieldName);
            if (!fieldMeta) {
              clearFieldMetaCache(tableId);
              throw new Error(`Field name ${fieldName} from record ${record.record_id} not found in table ${tableId}`);
            }
            mappedFields[fieldMeta.fieldId] = value;
            mappedFields[fieldMeta.fieldName] = value;
          }
          return {
            recordId: requireString(record.record_id, `record_id missing in table ${tableId}`),
            fields: mappedFields,
          };
        }),
        hasMore: Boolean(page.has_more),
        pageToken: page.page_token,
      };
    },

    async addTable(name: string, fields: unknown[]): Promise<{ tableId: string }> {
      const data = await openApiRequest<{ table_id?: string }>(`/bitable/v1/apps/${encodeURIComponent(options.baseToken)}/tables`, {
        method: 'POST',
        body: JSON.stringify({
          table: {
            name,
            fields: fields.map((field) => toOpenApiField(field)),
          },
        }),
      });

      return { tableId: requireString(data.table_id, `table_id missing after creating table ${name}`) };
    },

    async addRecords(tableId: string, records: Array<{ fields: Record<string, unknown> }>): Promise<string[]> {
      const convertedRecords = await Promise.all(
        records.map(async (record) => ({
          fields: await toFieldNames(tableId, record.fields),
        })),
      );
      const data = await openApiRequest<{ records?: Array<{ record_id?: string }> }>(
        `/bitable/v1/apps/${encodeURIComponent(options.baseToken)}/tables/${encodeURIComponent(tableId)}/records/batch_create`,
        {
          method: 'POST',
          body: JSON.stringify({ records: convertedRecords }),
        },
      );

      return requireArray(data.records, `records missing after creating records in ${tableId}`).map((record) =>
        requireString(record.record_id, `record_id missing after creating record in ${tableId}`),
      );
    },

    async setRecords(tableId: string, records: Array<{ recordId: string; fields: Record<string, unknown> }>): Promise<Array<{ recordId: string }>> {
      const convertedRecords = await Promise.all(
        records.map(async (record) => ({
          record_id: record.recordId,
          fields: await toFieldNames(tableId, record.fields),
        })),
      );
      const data = await openApiRequest<{ records?: Array<{ record_id?: string }> }>(
        `/bitable/v1/apps/${encodeURIComponent(options.baseToken)}/tables/${encodeURIComponent(tableId)}/records/batch_update`,
        {
          method: 'POST',
          body: JSON.stringify({ records: convertedRecords }),
        },
      );

      return requireArray(data.records, `records missing after updating records in ${tableId}`).map((record) => ({
        recordId: requireString(record.record_id, `record_id missing after updating record in ${tableId}`),
      }));
    },
  };

  return runtime;
}

type OpenApiTable = {
  table_id?: string;
  name?: string;
};

type OpenApiField = {
  field_id?: string;
  field_name?: string;
  type?: string | number;
};

type OpenApiRecord = {
  record_id?: string;
  fields?: Record<string, unknown>;
};

type FieldMetaCacheEntry = {
  promise: Promise<RuntimeCategory[]>;
  expiresAt: number;
};

async function listAllPages<U>(
  requestPage: (pageToken?: string) => Promise<{ items?: U[]; has_more?: boolean; page_token?: string }>,
): Promise<U[]> {
  const items: U[] = [];
  let pageToken: string | undefined;
  do {
    const page = await requestPage(pageToken);
    items.push(...requireArray(page.items, 'items missing from Feishu OpenAPI paged response'));
    pageToken = page.has_more ? requireString(page.page_token, 'page_token missing while has_more is true') : undefined;
  } while (pageToken);
  return items;
}

function createPageParams(pageSize: number, pageToken?: unknown): URLSearchParams {
  const params = new URLSearchParams({ page_size: String(pageSize) });
  if (pageToken !== undefined) {
    params.set('page_token', requireString(pageToken, 'pageToken must be a non-empty string'));
  }
  return params;
}

function toOpenApiField(field: unknown): { field_name: string; type: unknown } {
  if (!isRecord(field)) {
    throw new Error('Field definition must be an object');
  }
  const name = field.name ?? field.field_name;
  return {
    field_name: requireString(name, 'field name missing while creating table'),
    type: requirePresent(field.type, `field type missing for ${String(name)}`),
  };
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(message);
  }
  return value;
}

function requirePresent<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

function requireArray<T>(value: T[] | null | undefined, message: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(message);
  }
  return value;
}

function buildFieldMetaIndex(fields: RuntimeCategory[]): Map<string, RuntimeCategory> {
  const index = new Map<string, RuntimeCategory>();
  for (const field of fields) {
    index.set(field.fieldId, field);
    index.set(field.fieldName, field);
  }
  return index;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
