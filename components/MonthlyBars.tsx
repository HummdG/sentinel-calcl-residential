'use client';

import type { ChartSeries } from '@/lib/types';

// Custom div-based bars, matching sentinelRenderMonthlyBars() in the original.
export default function MonthlyBars({ data }: { data: ChartSeries }) {
  const { solar, sentinel, labels } = data;
  const mx = Math.max(...sentinel, 1);

  return (
    <>
      <div className="mbars">
        {solar.map((s, i) => {
          const sh = Math.round((s / mx) * 72);
          const th = Math.round((sentinel[i] / mx) * 72);
          return (
            <div
              className="bgrp"
              key={i}
              title={`${labels[i]}: Solar £${Math.round(s)} | Sentinel £${Math.round(sentinel[i])}`}
            >
              <div className="bar sb" style={{ height: Math.max(sh, 2) }} />
              <div className="bar tb" style={{ height: Math.max(th, 2) }} />
            </div>
          );
        })}
      </div>
      <div className="mlabels">
        {labels.map((l, i) => (
          <div className="mlabel" key={i}>
            {l ? l[0] : ''}
          </div>
        ))}
      </div>
    </>
  );
}
