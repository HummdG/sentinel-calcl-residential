'use client';

import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Filler,
  Tooltip,
  Legend,
  type ChartOptions,
} from 'chart.js';
import type { ChartSeries } from '@/lib/types';

ChartJS.register(LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip, Legend);

const options: ChartOptions<'line'> = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      callbacks: {
        label: (c) => ' £' + (c.parsed.y as number).toLocaleString('en-GB'),
      },
    },
  },
  scales: {
    x: {
      grid: { color: 'rgba(255,255,255,.05)' },
      ticks: { color: '#64748b', font: { size: 11 }, maxTicksLimit: 14 },
    },
    y: {
      grid: { color: 'rgba(255,255,255,.05)' },
      ticks: {
        color: '#64748b',
        font: { size: 11 },
        callback: (v) => '£' + (Number(v) / 1000).toFixed(0) + 'k',
      },
    },
  },
};

export default function CumulativeChart({ data }: { data: ChartSeries }) {
  const chartData = {
    labels: data.labels,
    datasets: [
      {
        label: 'Solar+Battery',
        data: data.solar,
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245,158,11,.08)',
        tension: 0.4,
        fill: true,
        pointRadius: 3,
        borderWidth: 2,
      },
      {
        label: '+Sentinel',
        data: data.sentinel,
        borderColor: '#9333ea',
        backgroundColor: 'rgba(147,51,234,.1)',
        tension: 0.4,
        fill: true,
        pointRadius: 3,
        borderWidth: 2,
      },
    ],
  };

  return (
    <div className="cwrap">
      <Line data={chartData} options={options} />
    </div>
  );
}
