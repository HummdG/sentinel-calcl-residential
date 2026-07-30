'use client';

import type { ReactNode } from 'react';
import UploadZone from './UploadZone';
import type { FormState } from '@/lib/form';
import type { ParsedPdfResponse, Tariff, Usage } from '@/lib/types';

// A field the extractor could not find is marked distinctly from one it filled: a blank
// that looks ordinary is how a stale value passes for an extracted one.
function fieldClass(id: string, populated: Set<string>, missing?: Set<string>): string {
  if (missing?.has(id)) return 'field pdf-missing';
  return populated.has(id) ? 'field pdf-populated' : 'field';
}

interface NumFieldProps {
  id: keyof FormState;
  label: ReactNode;
  form: FormState;
  setField: (id: keyof FormState, v: string) => void;
  populated: Set<string>;
  missing?: Set<string>;
  step?: string;
  min?: string;
  unit?: string;
  pre?: string;
  placeholder?: string;
}

function NumField({ id, label, form, setField, populated, missing, step, min, unit, pre, placeholder }: NumFieldProps) {
  return (
    <div className={fieldClass(id, populated, missing)}>
      <label>{label}</label>
      <div className="frow">
        {pre && <span className="fpre">{pre}</span>}
        <input
          type="number"
          value={form[id]}
          step={step}
          min={min}
          placeholder={placeholder}
          onChange={(e) => setField(id, e.target.value)}
        />
        {unit && <span className="funit">{unit}</span>}
      </div>
    </div>
  );
}

interface TextFieldProps {
  id: keyof FormState;
  label: string;
  form: FormState;
  setField: (id: keyof FormState, v: string) => void;
  populated: Set<string>;
  missing?: Set<string>;
  placeholder?: string;
}

function TextField({ id, label, form, setField, populated, missing, placeholder }: TextFieldProps) {
  return (
    <div className={fieldClass(id, populated, missing)}>
      <label>{label}</label>
      <div className="frow">
        <input
          type="text"
          value={form[id]}
          placeholder={placeholder}
          onChange={(e) => setField(id, e.target.value)}
        />
      </div>
    </div>
  );
}

const italic: React.CSSProperties = {
  fontSize: 11,
  textTransform: 'none',
  letterSpacing: 0,
  fontWeight: 400,
  fontStyle: 'italic',
};

const SCENARIOS: { label: string; value: number }[] = [
  { label: 'Base case 7%', value: 7 },
  { label: 'High 10%', value: 10 },
  { label: 'Stress 12%', value: 12 },
  { label: 'Low 5%', value: 5 },
];

interface Props {
  form: FormState;
  setField: (id: keyof FormState, v: string) => void;
  tariff: Tariff;
  setTariff: (t: Tariff) => void;
  usage: Usage;
  setUsage: (u: Usage) => void;
  inflation: number;
  scenarioActive: number | null;
  onInflationSlider: (v: number) => void;
  onScenario: (v: number) => void;
  populated: Set<string>;
  missing: Set<string>;
  warnings: string[];
  onExtracted: (data: ParsedPdfResponse) => void;
  onCalculate: () => void;
  calculating: boolean;
  gaps: string[];
}

export default function InputForm({
  form,
  setField,
  tariff,
  setTariff,
  usage,
  setUsage,
  inflation,
  scenarioActive,
  onInflationSlider,
  onScenario,
  populated,
  missing,
  warnings,
  onExtracted,
  onCalculate,
  calculating,
  gaps,
}: Props) {
  return (
    <div id="inputs-section">
      <span className="badge">Sentinel EMS™</span>
      <h1>Sentinel Savings Calculator</h1>
      <p className="sub">
        Upload the OpenSolar PDF to auto-populate, or enter figures manually. All fields can be
        adjusted at any time.
      </p>

      {/* PDF UPLOAD */}
      <p className="slabel">
        Auto-populate from OpenSolar report{' '}
        <span style={{ ...italic, color: 'var(--hs-muted)' }}>
          optional, all fields editable manually
        </span>
      </p>
      <UploadZone onExtracted={onExtracted} warnings={warnings} />

      <hr />

      {/* CUSTOMER DETAILS */}
      <p className="slabel">Customer details</p>
      <div className="igrid">
        <TextField
          id="customer_name"
          label="Customer name"
          form={form}
          setField={setField}
          populated={populated}
          missing={missing}
          placeholder="e.g. John Smith"
        />
        <TextField
          id="customer_address"
          label="Property address (line 1)"
          form={form}
          setField={setField}
          populated={populated}
          missing={missing}
          placeholder="e.g. 12 High Street"
        />
      </div>

      <hr />

      {/* SECTION A: SYSTEM SPEC */}
      <p className="slabel">System specification</p>
      <div className="igrid t4">
        <NumField id="pv_size" label="Solar PV size" form={form} setField={setField} populated={populated} missing={missing} step="0.1" min="0" unit="kWp" />
        <NumField id="battery_kwh" label="Battery capacity" form={form} setField={setField} populated={populated} missing={missing} step="0.5" min="0" unit="kWh" />
        <NumField id="inverter_kw" label="Inverter power rating" form={form} setField={setField} populated={populated} missing={missing} step="0.1" min="0" unit="kW" />
        <NumField id="annual_gen" label="Annual generation" form={form} setField={setField} populated={populated} missing={missing} step="100" min="0" unit="kWh/yr" />
      </div>
      <div className="igrid">
        <NumField id="annual_usage" label="Annual consumption" form={form} setField={setField} populated={populated} missing={missing} step="100" min="0" unit="kWh/yr" />
        <NumField id="system_cost" label="Total system cost" form={form} setField={setField} populated={populated} missing={missing} step="100" min="0" pre="£" />
      </div>

      <hr />

      {/* SECTION B: OPENSOLAR FIGURES */}
      <p className="slabel">
        Solar &amp; battery figures{' '}
        <span style={{ ...italic, color: 'rgba(245,158,11,0.8)' }}>
          enter directly from OpenSolar report
        </span>
      </p>
      <div className="igrid t3">
        <NumField id="solar_savings" label="Annual bill savings — yr 1" form={form} setField={setField} populated={populated} missing={missing} step="50" min="0" pre="£" />
        <NumField id="export_kwh" label="Annual export to grid" form={form} setField={setField} populated={populated} missing={missing} step="100" min="0" unit="kWh/yr" />
        <NumField id="os_payback" label="Payback period" form={form} setField={setField} populated={populated} missing={missing} step="0.1" min="0" unit="years" />
      </div>
      <div className="igrid">
        <NumField id="os_25yr" label="25-year cumulative return" form={form} setField={setField} populated={populated} missing={missing} step="100" pre="£" />
        <NumField id="os_roi" label="Rate of return on investment" form={form} setField={setField} populated={populated} missing={missing} step="0.1" min="0" unit="%" placeholder="—" />
      </div>

      <hr />

      {/* SECTION C: TARIFF */}
      <p className="slabel">Customer tariff type</p>
      <div className="tgrid">
        <label className="toption">
          <input type="radio" name="tariff" value="standard" checked={tariff === 'standard'} onChange={() => setTariff('standard')} />
          <span className="tlabel">
            <span className="tname">Standard flat</span>
            <span className="tdesc">Single unit rate</span>
          </span>
        </label>
        <label className="toption">
          <input type="radio" name="tariff" value="daynight" checked={tariff === 'daynight'} onChange={() => setTariff('daynight')} />
          <span className="tlabel">
            <span className="tname">Day / Night</span>
            <span className="tdesc">Cheaper off-peak overnight</span>
          </span>
        </label>
        <label className="toption">
          <input type="radio" name="tariff" value="flux" checked={tariff === 'flux'} onChange={() => setTariff('flux')} />
          <span className="tlabel">
            <span className="tname">Smart / Flux</span>
            <span className="tdesc">Dynamic pricing, best for Sentinel</span>
          </span>
        </label>
      </div>

      <div className={`rate-panel${tariff === 'standard' ? ' visible' : ''}`}>
        <p className="rate-panel-title">Standard tariff rates</p>
        <div className="igrid">
          <NumField id="std_import" label="Import unit rate" form={form} setField={setField} populated={populated} missing={missing} step="0.1" min="0" unit="p/kWh" />
          <div className="field" style={{ background: 'transparent', borderColor: 'transparent' }} />
        </div>
      </div>

      <div className={`rate-panel${tariff === 'daynight' ? ' visible' : ''}`}>
        <p className="rate-panel-title">Day / Night tariff rates</p>
        <div className="igrid">
          <NumField id="dn_day" label="Day rate (peak import)" form={form} setField={setField} populated={populated} missing={missing} step="0.1" min="0" unit="p/kWh" />
          <NumField id="dn_night" label="Night rate (off-peak import)" form={form} setField={setField} populated={populated} missing={missing} step="0.1" min="0" unit="p/kWh" />
        </div>
      </div>

      <div className={`rate-panel${tariff === 'flux' ? ' visible' : ''}`}>
        <p className="rate-panel-title">Smart / Flux tariff</p>
        <p style={{ fontSize: 13, color: 'var(--hs-muted)' }}>
          Dynamic pricing is handled automatically by Sentinel&apos;s optimisation engine. No manual
          rates required. Sentinel will trade at the best available times.
        </p>
      </div>

      <hr style={{ marginTop: 20 }} />

      {/* SECTION D: USAGE PATTERN */}
      <p className="slabel">Energy usage pattern</p>
      <div className="tgrid">
        <label className="toption">
          <input type="radio" name="usage" value="daytime" checked={usage === 'daytime'} onChange={() => setUsage('daytime')} />
          <span className="tlabel">
            <span className="tname">Mostly daytime</span>
            <span className="tdesc">Home during the day</span>
          </span>
        </label>
        <label className="toption">
          <input type="radio" name="usage" value="balanced" checked={usage === 'balanced'} onChange={() => setUsage('balanced')} />
          <span className="tlabel">
            <span className="tname">Balanced</span>
            <span className="tdesc">Mixed usage pattern</span>
          </span>
        </label>
        <label className="toption">
          <input type="radio" name="usage" value="evening" checked={usage === 'evening'} onChange={() => setUsage('evening')} />
          <span className="tlabel">
            <span className="tname">Evening heavy</span>
            <span className="tdesc">Out during day, home evenings</span>
          </span>
        </label>
      </div>

      <hr />

      {/* SECTION E: INFLATION */}
      <p className="slabel">Energy price inflation assumption</p>
      <div className="slider-card">
        <div className="slider-header">
          <span className="slider-lbl">Annual energy price inflation rate</span>
          <span className="slider-val">{inflation}%</span>
        </div>
        <div className="slider-row">
          <span className="slider-min">3%</span>
          <input
            type="range"
            min="3"
            max="15"
            step="0.5"
            value={inflation}
            onChange={(e) => onInflationSlider(Number.parseFloat(e.target.value))}
          />
          <span className="slider-max">15%</span>
        </div>
        <div className="scenario-row">
          <span className="scenario-lbl">Scenarios:</span>
          {SCENARIOS.map((s) => (
            <button
              key={s.value}
              type="button"
              className={`scenario-btn${scenarioActive === s.value ? ' active' : ''}`}
              onClick={() => onScenario(s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Names what is still needed, so an incomplete quote can't produce a report. */}
      {gaps.length > 0 && (
        <div className="calc-gate">
          Still needed before a report can be produced: {gaps.join(', ')}.
        </div>
      )}
      <button
        className="cbtn"
        onClick={onCalculate}
        disabled={calculating || gaps.length > 0}
      >
        {calculating ? 'Calculating…' : 'Calculate Sentinel uplift'}
      </button>
    </div>
  );
}
