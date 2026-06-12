import { useEffect, FC, useState } from 'react';
import { Form, Button, Select, InputNumber, FormInstance } from 'antd';
import { DashboardState, IDataRange, AllDataRange, DATA_SOURCE_SORT_TYPE, GroupMode, ORDER, SourceType, bitable, dashboard, ICategory, IConfig, IData, FieldType, ISeries, Rollup } from "@lark-base-open/js-sdk";
import { Indicator } from './indicator';

export interface ITableSource {
  tableId: string;
  tableName: string;
}

export interface IFormValues {
  category: string;
  dataRange: string;
  table: string;
  statistics: 'VALUE' | 'COUNTA';
  indicators?: string[];
  // group_category?: string;
}

interface IConfigPanelProps {
  tableSource: ITableSource[];
  dataRange: IDataRange[];
  categories: ICategory[];
  // handleTableChange: (tableSource: string, form: FormInstance) => void;
  handleConfigChange: (changedVal: unknown, formValues: IFormValues, form: FormInstance) => void;
  onSaveConfig: (values: IFormValues) => void;
  numberFieldList: ICategory[];
  initFormValue?: IFormValues;
}

export const ConfigPanel: FC<IConfigPanelProps> = ({ initFormValue, tableSource, dataRange, categories, numberFieldList, handleConfigChange, onSaveConfig }) => {
  const [form] = Form.useForm();

  window.__form__ = form;

  return (
    <div className='config-panel'>
      {initFormValue && tableSource.length && categories.length ? (
        <>
          <Form
            form={form}
            name="basic"
            labelCol={{ span: 8 }}
            wrapperCol={{ span: 16 }}
            style={{ width: '100%' }}
            initialValues={initFormValue}
            onValuesChange={(changedVal, allValues) => handleConfigChange(changedVal, allValues, form)}
            autoComplete="off"
          >
            <Form.Item
              label="数据表"
              name="table"
            // rules={[{ required: true, message: 'Please input your username!' }]}
            >
              <Select
                defaultValue={tableSource[0]?.tableId}
                style={{ width: 200 }}
                // onChange={(val) => handleTableChange(val, form)}
                options={tableSource.map(source => ({
                  value: source.tableId,
                  label: source.tableName
                }))}
              />
            </Form.Item>
            <Form.Item
              label="数据范围"
              name="dataRange"
              rules={[{ required: true, message: 'Please input your password!' }]}
            >
              <Select
                style={{ width: 200 }}
                defaultValue={JSON.stringify(dataRange[0])}
                // onChange={handleDataRangeChange}
                options={dataRange.map(range => {
                  const { type } = range;
                  if (type === SourceType.ALL) {
                    return {
                      value: JSON.stringify(range),
                      label: '全部数据'
                    }
                  } else {
                    return {
                      value: JSON.stringify(range),
                      label: range.viewName
                    }
                  }
                })}
              />
            </Form.Item>
            <Form.Item
              name="category"
              label="统计分类"
            >
              <Select
                style={{ width: 200 }}
                defaultValue={categories[0]?.fieldId}
                // onChange={handleConfigChange}
                options={categories.map(category => {
                  const { fieldName } = category;
                  return {
                    value: category.fieldId,
                    label: fieldName
                  }
                })}
              />
            </Form.Item>
            {/* <Form.Item
              name="group_category"
              label="分组聚合"
            >
              <Select
                style={{ width: 200 }}
                // onChange={handleConfigChange}
                options={categories.filter(category => {
                  if (!form.getFieldValue('category')) return true;

                  return category.fieldId !== form.getFieldValue('category');
                }).map(category => {
                  const { fieldName } = category;
                  return {
                    value: JSON.stringify(category),
                    label: fieldName
                  }
                })}
              />
            </Form.Item> */}
            <Form.Item
              name="statistics"
              label="数值类型"
            >
              <Select
                defaultValue={'COUNTA'}
                style={{ width: 200 }}
                options={[
                  {
                    label: '统计记录总数',
                    value: 'COUNTA'
                  },
                  {
                    label: '统计字段数值',
                    value: 'VALUE'
                  }
                ]}
              />
            </Form.Item>
            {
              form.getFieldValue('statistics') === 'VALUE' &&
              <Indicator fieldList={numberFieldList} />
            }
          </Form>
          <Button onClick={() => {
            onSaveConfig(form.getFieldsValue(true));
          }} style={{ position: 'fixed', bottom: 10, right: 10 }} type="primary">
            确定
          </Button>
        </>)
        : null}
    </div>
  )
}