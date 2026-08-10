'use client';

import type { RefObject } from 'react';
import CumulativeChart from './CumulativeChart';
import MonthlyBars from './MonthlyBars';
import { sf, sfmtYrs } from '@/lib/format';
import type { CalcResult } from '@/lib/types';

interface Props {
  result: CalcResult;
  customerName: string;
  customerAddress: string;
  captureRef: RefObject<HTMLDivElement | null>;
}

const gb = (n: number) => Math.round(n).toLocaleString('en-GB');

export default function ResultsReport({ result: d, customerName, customerAddress, captureRef }: Props) {
  const name = customerName.trim();
  const addr = customerAddress.trim();

  // Every figure comes from the calculation result, never from live form state. Otherwise
  // a cell can belong to a newer edit than the numbers beside it.
  const osRoi = d.solar_roi;

  const dateStr = new Date().toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  // Measured against the payback the customer's own proposal states (d.solar_payback, the
  // same figure shown as "Payback without Sentinel"), not the internally recomputed
  // payback_solar. Otherwise the three payback numbers on the page don't reconcile. This
  // matches the WordPress plugin.
  const pbSave = d.solar_payback - d.payback_sentinel;

  return (
    <div id="pdf-capture" ref={captureRef}>
      <div className="pdf-report-header">
        <div>
          <div className="pdf-report-title">Sentinel EMS Financial Impact Report</div>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 2 }} />
          {name && (
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.9)', marginTop: 4 }}>
              Prepared for: <strong>{name}</strong>
              {addr && <span> &mdash; {addr}</span>}
            </div>
          )}
        </div>
        <div className="pdf-report-meta">{dateStr}</div>
      </div>

      <div className="rhead">
        <span className="rtitle">Results</span>
        <span className="utag">+{sf(d.extra_annual)} extra in year 1 with Sentinel</span>
        <span className="infl-badge">{d.inflation}% inflation assumed</span>
      </div>

      <div className="system-bar">
        {name && (
          <div className="sys-item">
            Customer: <strong>{name}</strong>
          </div>
        )}
        {addr && (
          <div className="sys-item">
            Address: <strong>{addr}</strong>
          </div>
        )}
        <div className="sys-item">
          Solar PV: <strong>{d.pv_size}kWp</strong>
        </div>
        <div className="sys-item">
          Battery: <strong>{d.battery_kwh}kWh</strong>
        </div>
        <div className="sys-item">
          Inverter: <strong>{d.inverter_kw}kW</strong>
        </div>
        <div className="sys-item">
          Annual generation: <strong>{gb(d.annual_gen)} kWh/yr</strong>
        </div>
        <div className="sys-item">
          Annual consumption: <strong>{gb(d.annual_usage)} kWh/yr</strong>
        </div>
        <div className="sys-item">
          System cost: <strong>{sf(d.system_cost)}</strong>
        </div>
      </div>

      <div className="ubanner">
        <div>
          <span className="uval">{sf(d.extra_annual)}</span>
          <span className="ulbl">
            Extra annual benefit
            <br />
            from Sentinel (yr 1)
          </span>
        </div>
        <div>
          <span className="uval p">{sfmtYrs(d.solar_payback)}</span>
          <span className="ulbl">
            Payback without
            <br />
            Sentinel
          </span>
        </div>
        <div>
          <span className="uval">{sfmtYrs(d.payback_sentinel)}</span>
          <span className="ulbl">
            Payback with
            <br />
            Sentinel
          </span>
        </div>
        <div>
          <span className="uval">{pbSave > 0 ? sfmtYrs(pbSave) : 'n/a'}</span>
          <span className="ulbl">
            Years saved on
            <br />
            payback
          </span>
        </div>
        <div>
          <span className="uval">
            {d.roi_annualised_pct > 0 ? d.roi_annualised_pct.toFixed(1) + '%' : 'n/a'}
          </span>
          <span className="ulbl">
            Rate of return
            <br />
            with Sentinel
          </span>
        </div>
      </div>

      {d.flux_arbitrage_warning && (
        <div className="arbitrage-warn on">
          &#9888; <strong>Flux arbitrage adjustment applied.</strong> This system&apos;s export kWh (
          {gb(d.export_kwh)} kWh) exceeds its annual solar generation ({gb(d.annual_gen)} kWh),
          meaning {gb(d.arbitrage_kwh)} kWh of the reported export represents grid-charged battery
          cycling rather than solar export. A grid charging cost of 7p/kWh has been deducted from the
          optimised export income to reflect the net position.{' '}
          <strong>
            Surveyor note: please verify the export figure with the OpenSolar report before presenting
            to the customer.
          </strong>
        </div>
      )}

      <div className="cgrid">
        <div className="card">
          <div className="chead">
            <span className="chtitle">Solar + Battery only</span>
            <span className="ostag">OpenSolar figures</span>
          </div>
          <div className="cbody">
            <div className="mrow">
              <span className="mlbl">Annual bill savings</span>
              <span className="mval a">{sf(d.solar_bill)}</span>
            </div>
            <div className="mrow">
              <span className="mlbl">SEG export income</span>
              <span className="mval a">{sf(d.solar_seg)}</span>
            </div>
            <div className="mrow">
              <span className="mlbl">AI Optimisation</span>
              <span className="mval dim">N/A</span>
            </div>
            <div className="mrow">
              <span className="mlbl">Market trading revenue</span>
              <span className="mval dim">N/A</span>
            </div>
            <div className="mrow mrow-total">
              <span className="mlbl">Total annual benefit</span>
              <span className="mval a">{sf(d.solar_total)}</span>
            </div>
            <div className="mrow">
              <span className="mlbl">Payback period</span>
              <span className="mval">{sfmtYrs(d.solar_payback)}</span>
            </div>
            <div className="mrow">
              <span className="mlbl">25 Year Cumulative Return</span>
              <span className="mval">{d.solar_25yr > 0 ? sf(d.solar_25yr) : '£0'}</span>
            </div>
            <div className="mrow">
              <span className="mlbl">Rate of return on investment</span>
              <span className="mval">{osRoi > 0 ? osRoi.toFixed(1) + '%' : 'n/a'}</span>
            </div>
          </div>
        </div>
        <div className="card sc">
          <div className="chead">
            <span className="chtitle">+ Sentinel EMS™</span>
            <span className="rectag">Recommended</span>
          </div>
          <div className="cbody">
            <div className="mrow">
              <span className="mlbl">Annual bill savings</span>
              <span className="mval g">{sf(d.sentinel_bill)}</span>
            </div>
            <div className="mrow">
              <span className="mlbl">Optimised export income</span>
              <span className="mval g">{sf(d.sentinel_seg)}</span>
            </div>
            <div className="mrow">
              <span className="mlbl">AI Optimisation</span>
              <span className="mval g">{sf(d.sentinel_peak)}</span>
            </div>
            <div className="mrow">
              <span className="mlbl">Market trading revenue (net)</span>
              <span className="mval g">{sf(d.sentinel_trade)}</span>
            </div>
            <div className="mrow mrow-total">
              <span className="mlbl">Total annual benefit</span>
              <span className="mval g">{sf(d.sentinel_total_yr1)} yr 1</span>
            </div>
            <div className="mrow">
              <span className="mlbl">Payback period</span>
              <span className="mval g">{sfmtYrs(d.sentinel_payback)}</span>
            </div>
            <div className="mrow">
              <span className="mlbl">25 Year Cumulative Return</span>
              <span className="mval g">{sf(d.sentinel_25yr)}</span>
            </div>
            <div className="mrow">
              <span className="mlbl">Rate of return on investment</span>
              <span className="mval g">
                {d.roi_annualised_pct > 0 ? d.roi_annualised_pct.toFixed(1) + '%' : 'n/a'}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="ccard">
        <p className="ctitle">Cumulative returns: 25 year projection</p>
        <CumulativeChart data={d.chart_cumulative} />
        <div className="legend">
          <div className="li">
            <div className="ld" style={{ background: '#f59e0b' }} />
            Solar + Battery only
          </div>
          <div className="li">
            <div className="ld" style={{ background: '#9333ea' }} />
            Solar + Battery + Sentinel
          </div>
        </div>
      </div>

      <div className="mcard">
        <p className="ctitle">Estimated monthly savings comparison</p>
        <MonthlyBars data={d.chart_monthly} />
        <div className="legend" style={{ marginTop: 10 }}>
          <div className="li">
            <div className="ld" style={{ background: '#f59e0b' }} />
            Solar + Battery
          </div>
          <div className="li">
            <div className="ld" style={{ background: '#9333ea' }} />+ Sentinel
          </div>
        </div>
      </div>

      <p className="disc">
        Solar + Battery figures sourced directly from OpenSolar report. Sentinel uplift figures are
        estimates based on system size, battery capacity, usage pattern, tariff type, and Intelligent
        Energy Partner residential scenario benchmarks (March 2026). Trading revenues are not
        guaranteed. Sentinel market revenues shown net of 20% Intelligent Energy Partner trading fee
        and 20% Sentinel optimisation fee. AI Optimisation and market trading revenue are not fully
        additive as they share the same battery cycles; a 10% non-additivity adjustment is applied to
        their combined total. Sentinel bill savings are capped only where the OpenSolar baseline
        figure exceeds the customer&apos;s estimated total electricity spend, to prevent overstating
        savings on anomalous system configurations. Where a Flux tariff is selected and the reported
        export kWh exceeds annual solar generation, a grid charging cost of 7p/kWh is deducted from
        the optimised export income to reflect the net cost of grid-charged battery arbitrage cycles.
        Sentinel subscription cost (£199/yr) deducted from year 2 onwards in Sentinel cumulative
        figures. Rate of return with Sentinel is calculated from 25-year cumulative return relative to
        system cost. Energy price inflation applied at {d.inflation}% per annum to cumulative
        projections. This calculator is a sales support tool for Solar &amp; Storage installation
        surveyors and should not be presented to customers as a guaranteed financial forecast.
      </p>
    </div>
  );
}
