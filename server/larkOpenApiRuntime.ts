import { buildFieldMetaIndex, createFeishuBaseApi, type FeishuBaseApi } from './feishuBaseApi';
import type { FeishuBaseClient } from './feishuBaseClient';

export type LarkOpenApiRuntimeOptions = {
  baseToken: string;
  authCode?: string;
  fetchImpl?: typeof fetch;
  client?: FeishuBaseClient;
  api?: FeishuBaseApi;
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
  addField(tableId: string, field: unknown): Promise<{ fieldId: string }>;
  addRecords(tableId: string, records: Array<{ fields: Record<string, unknown> }>): Promise<string[]>;
  setRecords(tableId: string, records: Array<{ recordId: string; fields: Record<string, unknown> }>): Promise<Array<{ recordId: string }>>;
};

const FIELD_META_CACHE_TTL_MS = 5 * 60 * 1000;

export function createLarkOpenApiRuntime(options: LarkOpenApiRuntimeOptions): LarkOpenApiRuntime {
  const baseToken = requireString(options.baseToken, 'baseToken is required for Feishu Base runtime');
  const api =
    options.api ??
    createFeishuBaseApi(
      options.client
        ? {
            baseToken,
            client: options.client,
          }
        : {
            baseToken,
            authCode: requireString(options.authCode, 'authCode is required for Feishu Base runtime'),
            fetchImpl: options.fetchImpl,
          },
    );
  const fieldCache = new Map<string, FieldMetaCacheEntry>();

  const clearFieldMetaCache = (tableId?: string): void => {
    if (tableId) {
      fieldCache.delete(tableId);
      return;
    }
    fieldCache.clear();
  };

  const getFieldMetaList = (tableId: string): Promise<RuntimeCategory[]> => {
    const cached = fieldCache.get(tableId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.promise;
    }
    fieldCache.delete(tableId);

    const fieldsPromise = api
      .listAllFields(tableId)
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
      const tables = await api.listAllTables();

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
      const [fields, page] = await Promise.all([
        getFieldMetaList(tableId),
        api.listRecordsPage(tableId, params),
      ]);
      const fieldMetaByKey = buildFieldMetaIndex(fields);

      return {
        records: readPageRecords(page, tableId).map((record) => {
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
      const data = await api.createTable(name, fields);

      return { tableId: requireString(data.table_id, `table_id missing after creating table ${name}`) };
    },

    async addField(tableId: string, field: unknown): Promise<{ fieldId: string }> {
      const data = await api.createField(tableId, field);
      const fieldId = requireString(data.field_id, `field_id missing after creating field in ${tableId}`);
      clearFieldMetaCache(tableId);
      return { fieldId };
    },

    async addRecords(tableId: string, records: Array<{ fields: Record<string, unknown> }>): Promise<string[]> {
      const convertedRecords = await Promise.all(
        records.map(async (record) => ({
          fields: await toFieldNames(tableId, record.fields),
        })),
      );
      const data = await api.createRecords(tableId, convertedRecords);

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
      const data = await api.updateRecords(tableId, convertedRecords);

      return requireArray(data.records, `records missing after updating records in ${tableId}`).map((record) => ({
        recordId: requireString(record.record_id, `record_id missing after updating record in ${tableId}`),
      }));
    },
  };

  return runtime;
}

type FieldMetaCacheEntry = {
  promise: Promise<RuntimeCategory[]>;
  expiresAt: number;
};

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

function readPageRecords(page: { records?: unknown[]; items?: unknown[]; hasMore?: boolean; has_more?: boolean }, tableId: string): Array<{ record_id?: string; recordId?: string; fields?: Record<string, unknown> }> {
  const records = page.records ?? page.items;
  if (Array.isArray(records)) {
    return records as Array<{ record_id?: string; recordId?: string; fields?: Record<string, unknown> }>;
  }
  if (!Boolean(page.hasMore ?? page.has_more)) {
    return [];
  }
  throw new Error(`records missing from records response for table ${tableId}`);
}
