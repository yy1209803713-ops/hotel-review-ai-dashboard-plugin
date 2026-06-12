import { useEffect, useMemo, useRef } from 'react';
import * as ECharts from 'echarts';

interface RadarChartProps {
  indicatorLimit: number;
  dataSet: Array<(string | number)[]>;
}

export function RadarChart({ dataSet }: RadarChartProps) {
  const chartIns = useRef();

  const indicatorSet = useMemo(() => {
    const set: { max: number, name: string }[] = [];

    for (let i = 1; i < dataSet.length; i++) {

      set.push(
        {
          max: 100,
          name: dataSet[i][0] as string
        }
      )
    }
    return set;
  }, [dataSet]);

  const radarSeries = useMemo(() => {
    const series = {
      type: 'radar',
      name: 'test',
      data: []
    }
    for (let i = 1; i < dataSet?.[0]?.length; i++) {
      const seriesData = {
        name: dataSet[0][i],
        value: []
      }
      for (let j = 1; j < dataSet.length; j++) {
        seriesData.value.push(dataSet[j][i]);
      }
      series.data.push(seriesData)
    }
    return series;
  }, [dataSet])

  useEffect(() => {
    const el = document.querySelector('.radar-chart') as HTMLElement;
    if (!el || !indicatorSet.length) return;

    const chart = ECharts.init(el);
    chartIns.current = chart;
    chartIns.current.setOption({
      title: {
        text: ''
      },
      tooltip: {},
      legend: {
        //   data: ['Allocated Budget', 'Actual Spending']
      },
      radar: {
        // shape: 'circle',
        indicator: indicatorSet
      },
      dataset: {
        source: dataSet
      },
      series: [
        radarSeries
      ]
    })

    function resize() {
      chartIns.current.resize();
    }

    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
    }
  }, [radarSeries, indicatorSet, dataSet])


  return (
    <div className='radar-chart'>
    </div>
  )
}