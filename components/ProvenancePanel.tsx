'use client';

import { useState } from 'react';
import type { FieldProvenance } from '@/lib/types';

// Where each extracted number came from.
//
// The point is auditability before Calculate: a surveyor can confirm in one glance that
// the system cost came off the quotation page rather than out of a savings block, without
// opening the PDF alongside. It also shows the values that were REJECTED, with the reason.
// A blank box tells you nothing, whereas "quoted text not found in the document" tells
// you the model invented it and you should type the figure yourself.

const LABELS: Record<string, string> = {
  customer_name: 'Customer name',
  customer_address: 'Address',
  pv_size: 'Solar PV size (kWp)',
  battery_kwh: 'Battery capacity (kWh)',
  inverter_kw: 'Inverter rating (kW)',
  annual_gen: 'Annual generation (kWh)',
  annual_usage: 'Annual consumption (kWh)',
  system_cost: 'Total system cost (£)',
  solar_savings: 'Year-1 bill saving (£)',
  export_kwh: 'Annual export (kWh)',
  os_payback: 'Payback (years)',
  os_25yr: 'Lifetime net saving (£)',
  os_roi: 'Rate of return (%)',
};

const STATUS_TEXT: Record<FieldProvenance['status'], string> = {
  verified: 'Verified',
  unverified: 'Rejected',
  absent: 'Not in document',
};

export default function ProvenancePanel({ provenance }: { provenance: FieldProvenance[] }) {
  const [open, setOpen] = useState(false);

  if (!provenance.length) return null;

  const verified = provenance.filter((p) => p.status === 'verified').length;
  const rejected = provenance.filter((p) => p.status === 'unverified').length;

  return (
    <div className="provenance">
      <button
        type="button"
        className="provenance-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '▾' : '▸'} Where these figures came from
        <span className="provenance-count">
          {verified} verified{rejected > 0 ? `, ${rejected} rejected` : ''}
        </span>
      </button>

      {open && (
        <table className="provenance-table">
          {/* Widths live here, not on the cells. `table-layout: fixed` sizes
              every column from the FIRST row, so widths set on `td` are ignored
              and all four columns collapse to an even quarter each. */}
          <colgroup>
            <col className="prov-col-field" />
            <col className="prov-col-value" />
            <col className="prov-col-page" />
            <col className="prov-col-source" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Value</th>
              <th scope="col">Page</th>
              <th scope="col">Source text</th>
            </tr>
          </thead>
          <tbody>
            {provenance.map((p) => {
              const hasValue = p.value !== null && p.value !== '';
              return (
                <tr key={p.field} className={`prov-${p.status}`}>
                  <th scope="row">{LABELS[p.field] ?? p.field}</th>
                  <td>
                    {hasValue && <span className="prov-value">{String(p.value)} </span>}
                    <span className="prov-status">{STATUS_TEXT[p.status]}</span>
                  </td>
                  <td>{p.page ?? <span className="prov-none">·</span>}</td>
                  <td>
                    {p.evidence && <q>{p.evidence}</q>}
                    {p.note && <div className="prov-note">{p.note}</div>}
                    {!p.evidence && !p.note && <span className="prov-none">·</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
