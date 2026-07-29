'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import InputForm from './InputForm';
import ResultsReport from './ResultsReport';
import EmailModal from './EmailModal';
import { buildReportPdf, reportFilename } from '@/lib/pdf-report';
import { DEFAULT_FORM, applyExtracted, buildCalcInput, type FormState } from '@/lib/form';
import type { CalcResult, ExtractedFields, Tariff, Usage } from '@/lib/types';

function DownloadIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function EmailIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  );
}

export default function Calculator() {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [tariff, setTariff] = useState<Tariff>('standard');
  const [usage, setUsage] = useState<Usage>('daytime');
  const [inflation, setInflation] = useState<number>(7);
  const [scenarioActive, setScenarioActive] = useState<number | null>(7);
  const [populated, setPopulated] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<CalcResult | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const captureRef = useRef<HTMLDivElement | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);

  // Latest input state, so the stable runCalculate closure always reads fresh values.
  const stateRef = useRef({ form, tariff, usage, inflation });
  stateRef.current = { form, tariff, usage, inflation };

  const runCalculate = useCallback(async () => {
    const s = stateRef.current;
    setCalculating(true);
    try {
      const res = await fetch('/api/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildCalcInput(s.form, s.tariff, s.usage, s.inflation)),
      });
      if (!res.ok) throw new Error('Calculation failed');
      const data = (await res.json()) as CalcResult;
      setResult(data);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Sentinel calculate error:', e);
    } finally {
      setCalculating(false);
    }
  }, []);

  // Initial calculation on mount + live recalc when tariff / usage / inflation change.
  useEffect(() => {
    runCalculate();
  }, [tariff, usage, inflation, runCalculate]);

  // Esc closes the email modal.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setEmailOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const setField = useCallback((id: keyof FormState, value: string) => {
    setForm((f) => ({ ...f, [id]: value }));
  }, []);

  const onExtracted = useCallback((fields: ExtractedFields) => {
    const { form: next, populated: pop } = applyExtracted(stateRef.current.form, fields);
    setForm(next);
    setPopulated(pop);
  }, []);

  const onInflationSlider = useCallback((v: number) => {
    setInflation(v);
    setScenarioActive(null);
  }, []);

  const onScenario = useCallback((v: number) => {
    setInflation(v);
    setScenarioActive(v);
  }, []);

  const onCalculate = useCallback(() => {
    runCalculate();
    setTimeout(
      () => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      100
    );
  }, [runCalculate]);

  const onDownload = useCallback(async () => {
    if (!captureRef.current) return;
    setDownloading(true);
    try {
      const pdf = await buildReportPdf(captureRef.current);
      pdf.save(reportFilename());
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Sentinel PDF export error:', e);
      alert(e instanceof Error ? e.message : 'PDF generation failed. Please try again.');
    } finally {
      setDownloading(false);
    }
  }, []);

  const buildPdfDataUri = useCallback(async () => {
    if (!captureRef.current) throw new Error('Report not ready. Please try again.');
    const pdf = await buildReportPdf(captureRef.current);
    return pdf.output('datauristring');
  }, []);

  const osRoi = Number.parseFloat(form.os_roi) || 0;

  return (
    <div className="shell">
      <InputForm
        form={form}
        setField={setField}
        tariff={tariff}
        setTariff={setTariff}
        usage={usage}
        setUsage={setUsage}
        inflation={inflation}
        scenarioActive={scenarioActive}
        onInflationSlider={onInflationSlider}
        onScenario={onScenario}
        populated={populated}
        onExtracted={onExtracted}
        onCalculate={onCalculate}
        calculating={calculating}
      />

      {result && (
        <div id="results" className="on" ref={resultsRef}>
          <hr />
          <ResultsReport
            result={result}
            customerName={form.customer_name}
            customerAddress={form.customer_address}
            osRoi={osRoi}
            captureRef={captureRef}
          />
          <div className="pdf-actions">
            <button className="pdf-btn" onClick={onDownload} disabled={downloading}>
              <DownloadIcon />
              {downloading ? 'Generating PDF…' : 'Download PDF report'}
            </button>
            <button className="pdf-btn email-btn" onClick={() => setEmailOpen(true)}>
              <EmailIcon />
              Email PDF report
            </button>
          </div>
          <p
            style={{
              textAlign: 'center',
              fontSize: 11,
              color: 'rgba(255,255,255,0.18)',
              margin: '16px 0 0',
              letterSpacing: '0.05em',
            }}
          >
            Next.js edition
          </p>
        </div>
      )}

      <EmailModal
        open={emailOpen}
        onClose={() => setEmailOpen(false)}
        customerName={form.customer_name}
        buildPdfDataUri={buildPdfDataUri}
      />
    </div>
  );
}
