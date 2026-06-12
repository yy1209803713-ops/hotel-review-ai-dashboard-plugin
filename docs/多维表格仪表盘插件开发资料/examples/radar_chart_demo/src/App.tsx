import './App.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DashboardState, IDataRange, AllDataRange, DATA_SOURCE_SORT_TYPE, GroupMode, ORDER, SourceType, bitable, dashboard, ICategory, IConfig, IData, FieldType, ISeries, Rollup, IDataCondition } from "@lark-base-open/js-sdk";
import { Form, FormInstance } from 'antd';
import { RadarChart } from './components/radar_chart'
import { ConfigPanel, IFormValues, ITableSource } from './components/config_panel';

export default function App() {
  const [tableSource, setTableSource] = useState<ITableSource[]>([]);
  const [dataRange, setDataRange] = useState<IDataRange[]>([{ type: SourceType.ALL }]);
  const [categories, setCategories] = useState<ICategory[]>([]);
  const [initFormValue, setInitFormValue] = useState<IFormValues>();
  const [renderData, setRenderData] = useState<IData>([]);

  const getTableList = useCallback(async () => {
    const tables = await bitable.base.getTableList();
    return await Promise.all(tables.map(async table => {
      const name = await table.getName();
      return {
        tableId: table.id,
        tableName: name
      }
    }))
  }, [])

  const getTableRange = useCallback((tableId: string) => {
    return dashboard.getTableDataRange(tableId);
  }, [])

  const getCategories = useCallback((tableId: string) => {
    return dashboard.getCategories(tableId);
  }, [])

  // 展示态
  useEffect(() => {
    if (dashboard.state === DashboardState.View || dashboard.state === DashboardState.FullScreen) {
      dashboard.getData().then(data => {
        setRenderData(data);
      });

      dashboard.onDataChange(async (res) => {
        setRenderData(res.data);
      })
    }
  }, [])

  // 配置态
  useEffect(() => {
    if (dashboard.state === DashboardState.Config || dashboard.state === DashboardState.Create) {
      async function init() {
        const tableList = await getTableList();
        setTableSource(tableList);

        let formInitValue: IFormValues = {} as IFormValues, previewConfig: IDataCondition = {} as IDataCondition;
        if (dashboard.state === DashboardState.Create) {
          // 创建阶段没有任何配置，设置默认配置
          const tableId = tableList[0]?.tableId;

          const [tableRanges, categories] = await Promise.all([getTableRange(tableId), getCategories(tableId)]);
          setDataRange(tableRanges);
          setCategories(categories);

          formInitValue = {
            table: tableId,
            dataRange: JSON.stringify(tableRanges[0]),
            category: categories[0].fieldId,
            indicators: undefined,
            statistics: 'COUNTA'
          }

          previewConfig = {
            tableId,
            dataRange: tableRanges[0],
            series: 'COUNTA',
            groups: [
              {
                fieldId: categories[0].fieldId,
                mode: GroupMode.INTEGRATED,
                sort: {
                  order: ORDER.ASCENDING,
                  sortType: DATA_SOURCE_SORT_TYPE.VIEW
                }
              }
            ]
          }
        } else {
          const config = await dashboard.getConfig();
          const { dataConditions } = config;

          let { tableId, dataRange, groups, series } = dataConditions[0];

          const [tableRanges, categories] = await Promise.all([getTableRange(tableId), getCategories(tableId)]);
          setDataRange(tableRanges);
          setCategories(categories);

          const statistics = series === 'COUNTA' ? 'COUNTA' : 'VALUE';

          formInitValue = {
            table: tableId,
            dataRange: JSON.stringify(dataRange),
            category: groups?.[0]?.fieldId ?? '',
            indicators: statistics === 'VALUE' ? (series as ISeries[]).map(seri => seri.fieldId) : undefined,
            statistics
          }

          previewConfig = {
            tableId,
            groups,
            dataRange,
            series
          }
        }

        setInitFormValue(formInitValue);

        const data = await dashboard.getPreviewData(previewConfig);
        setRenderData(data);
      }
      init();
    }
  }, [getTableList, getTableRange, getCategories])

  const numberFieldList = useMemo(() => {
    return categories.filter(category => category.fieldType === FieldType.Number);
  }, [categories])

  const handleConfigChange = async (changedVal, allValues: IFormValues, form: FormInstance) => {
    let { category, dataRange, table, statistics, indicators } = allValues;

    if (changedVal.table) {
      const tableRanges = await getTableRange(changedVal.table);
      setDataRange(tableRanges);
      const categories = await getCategories(changedVal.table);
      setCategories(categories);

      form.setFieldValue('category', categories[0].fieldId);
      category = categories[0].fieldId;

      form.setFieldValue('dataRange', JSON.stringify({
        type: SourceType.ALL
      }))
      dataRange = JSON.stringify({
        type: SourceType.ALL
      });

      form.setFieldValue('statistics', 'COUNTA')
    }

    if (changedVal?.statistics) {
      if (changedVal?.statistics == 'COUNTA') {
        form.setFieldValue('indicators', undefined)
        indicators = undefined;
      } else {
        form.setFieldValue('indicators', [numberFieldList[0]?.fieldId])
        indicators = [numberFieldList[0]?.fieldId];
      }
    }

    const dataRangeObj = JSON.parse(dataRange);

    const groups = [
      {
        fieldId: category,
        mode: GroupMode.INTEGRATED,
        sort: {
          order: ORDER.ASCENDING,
          sortType: DATA_SOURCE_SORT_TYPE.VIEW
        }
      }
    ]

    let series: 'COUNTA' | ISeries[];
    if (statistics === 'COUNTA') {
      series = 'COUNTA';
    } else if (indicators?.length) {
      series = indicators.filter(indicator => !!indicator).map(fieldId => ({
        fieldId,
        rollup: Rollup.AVERAGE
      }))
    }

    // if (group_category) {
    //   const groupCategory = JSON.parse(group_category);
    //   const { fieldId } = groupCategory;
    //   groups.push({
    //     fieldId: fieldId,
    //     mode: GroupMode.INTEGRATED,
    //     sort: {
    //       order: ORDER.ASCENDING,
    //       sortType: DATA_SOURCE_SORT_TYPE.VIEW
    //     }
    //   })
    // }

    const data = await dashboard.getPreviewData({
      tableId: table,
      dataRange: dataRangeObj,
      series,
      groups
    })

    setRenderData(data);
  }

  const saveConfig = (allValues) => {
    const { category, dataRange, table, indicators } = allValues;

    const dataRangeObj = JSON.parse(dataRange);

    const groups = [
      {
        fieldId: category,
        mode: GroupMode.INTEGRATED,
        sort: {
          order: ORDER.ASCENDING,
          sortType: DATA_SOURCE_SORT_TYPE.VIEW
        }
      }
    ]

    let series: 'COUNTA' | ISeries[];
    if (!indicators || indicators.filter(indicator => !!indicator).length === 0) {
      series = 'COUNTA';
    } else {
      series = indicators.map(fieldId => ({
        fieldId,
        rollup: Rollup.AVERAGE
      }))
    }

    // if (group_category) {
    //   const groupCategory = JSON.parse(group_category);
    //   const { fieldId } = groupCategory;
    //   groups.push({
    //     fieldId: fieldId,
    //     mode: GroupMode.INTEGRATED,
    //     sort: {
    //       order: ORDER.ASCENDING,
    //       sortType: DATA_SOURCE_SORT_TYPE.VIEW
    //     }
    //   })
    // }

    const dataCondition = {
      tableId: table,
      dataRange: dataRangeObj,
      series,
      groups
    }

    dashboard.saveConfig({
      dataConditions: dataCondition
    })
  }

  useEffect(() => {
    if (dashboard.state === DashboardState.FullScreen) {
      const html = document.getElementsByTagName('html')[0];
      const body = document.getElementsByTagName('body')[0];
      html.classList.add('full_screen_app');
      body.classList.add('full_screen_app');
    }
  }, [])

  return (
    <div className='chart-app'>
      <RadarChart indicatorLimit={1} dataSet={renderData.map(data => data.map(item => item.value ?? ''))} />
      {dashboard.state === DashboardState.Create || dashboard.state === DashboardState.Config ? (
        <ConfigPanel
          // handleTableChange={handleTableChange}
          handleConfigChange={handleConfigChange}
          tableSource={tableSource}
          dataRange={dataRange}
          categories={categories}
          onSaveConfig={saveConfig}
          initFormValue={initFormValue}
          numberFieldList={numberFieldList} />
      ) : null}
    </div>
  );
}