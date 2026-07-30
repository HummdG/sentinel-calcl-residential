'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import InputForm from './InputForm';
import ResultsReport from './ResultsReport';
import EmailModal from './EmailModal';
import { buildReportPdf, reportFilename } from '@/lib/pdf-report';
import {
  DEFAULT_FORM,
  applyExtracted,
  buildCalcInput,
  gateFailures,
  type FormState,
} from '@/lib/form';
import type { CalcResult, ParsedPdfResponse, Tariff, Usage } from '@/lib/types';

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
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [warnings, setWarnings] = useState<string[]>([]);
  const [result, setResult] = useState<CalcResult | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [stale, setStale] = useState(false);
  const [calcError, setCalcError] = useState<string | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  // Customer details as they were when the current result was calculated.
  const [snapshot, setSnapshot] = useState({ customerName: '', customerAddress: '' });

  const captureRef = useRef<HTMLDivElement | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);

  // Latest input state, so the stable runCalculate closure always reads fresh values.
  const stateRef = useRef({ form, tariff, usage, inflation });
  stateRef.current = { form, tariff, usage, inflation };

  // Fields the surveyor has typed into since the last extraction — a second upload must
  // not clobber a hand-corrected figure.
  const editedRef = useRef<Set<string>>(new Set());
  // Has a real calculation happened yet? Guards the mount effect: the form ships blank, so
  // calculating on mount would render a full, exportable report out of nothing.
  const hasCalculatedRef = useRef(false);
  // Monotonic request id — only the newest response may render, so dragging the inflation
  // slider can't leave the report showing whichever reply happened to resolve last.
  const seqRef = useRef(0);
  // Pending debounced recalculation, so an export can cancel it and calculate immediately
  // rather than racing it.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const gaps = gateFailures(form);
  const ready = gaps.length === 0;
  const readyRef = useRef(ready);
  readyRef.current = ready;

  // Resolves true when this call actually rendered, false when a newer request superseded it.
  const runCalculate = useCallback(async (): Promise<boolean> => {
    if (!readyRef.current) {
      throw new Error('Missing required values: ' + gateFailures(stateRef.current.form).join(', '));
    }
    const s = stateRef.current;
    const seq = ++seqRef.current;
    setCalculating(true);
    try {
      const res = await fetch('/api/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildCalcInput(s.form, s.tariff, s.usage, s.inflation)),
      });
      if (!res.ok) throw new Error('Calculation failed');
      const data = (await res.json()) as CalcResult;
      if (seq !== seqRef.current) return false; // superseded by a newer request
      setResult(data);
      // Customer details are not part of the server calculation, so they are captured here
      // alongside it. Rendering from this snapshot keeps every cell of the report — name,
      // address and figures — from the same moment in time.
      setSnapshot({
        customerName: s.form.customer_name.trim(),
        customerAddress: s.form.customer_address.trim(),
      });
      hasCalculatedRef.current = true;
      setStale(false);
      setCalcError(null);
      return true;
    } catch (e) {
      if (seq !== seqRef.current) return false;
      // eslint-disable-next-line no-console
      console.error('Sentinel calculate error:', e);
      // Leave the report marked stale: it does NOT reflect the current inputs, and saying
      // so is safer than a silently outdated report the surveyor might still export.
      setStale(true);
      setCalcError(e instanceof Error ? e.message : 'Calculation failed.');
      throw e;
    } finally {
      if (seq === seqRef.current) setCalculating(false);
    }
  }, []);

  // Live recalc when tariff / usage / inflation change — but NOT on mount.
  useEffect(() => {
    if (!hasCalculatedRef.current) return;
    runCalculate().catch(() => {
      /* surfaced via calcError / stale */
    });
  }, [tariff, usage, inflation, runCalculate]);

  // Any edit to a figure makes the report older than the inputs above it. Mark it stale
  // immediately, then close the gap with a debounced recalculation, so a corrected value
  // always reaches both the report and the exported PDF.
  useEffect(() => {
    if (!hasCalculatedRef.current) return;
    setStale(true);
    if (!ready) return;
    const t = setTimeout(() => {
      debounceRef.current = null;
      runCalculate().catch(() => {
        /* surfaced via calcError / stale */
      });
    }, 400);
    debounceRef.current = t;
    return () => clearTimeout(t);
  }, [form, ready, runCalculate]);

  // Esc closes the email modal.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setEmailOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const setField = useCallback((id: keyof FormState, value: string) => {
    editedRef.current.add(id);
    setForm((f) => ({ ...f, [id]: value }));
    // A value the surveyor has supplied is no longer a gap.
    if (value.trim() !== '') {
      setMissing((m) => {
        if (!m.has(id)) return m;
        const next = new Set(m);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const onExtracted = useCallback((data: ParsedPdfResponse) => {
    const {
      form: next,
      populated: pop,
      missing: miss,
      preserved,
    } = applyExtracted(stateRef.current.form, data.fields, data.missing, editedRef.current);
    setForm(next);
    setPopulated(pop);
    setMissing(miss);
    setWarnings(data.warnings ?? []);
    // A fresh extraction is the new baseline for "hand-edited".
    editedRef.current = new Set(preserved);
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
    const first = !hasCalculatedRef.current;
    runCalculate()
      .then(() => {
        if (first) {
          setTimeout(
            () => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
            100
          );
        }
      })
      .catch(() => {
        /* surfaced via the gate message / calcError */
      });
  }, [runCalculate]);

  // Guarantees the report reflects the CURRENT inputs before anything is rasterised.
  // buildReportPdf photographs the DOM, so without this an edit made after the last
  // calculation is absent from the exported PDF — the surveyor sees a corrected system cost
  // on screen and sends a PDF still showing the old one.
  const ensureFresh = useCallback(async () => {
    const failures = gateFailures(stateRef.current.form);
    if (failures.length) {
      throw new Error('Cannot produce a report yet — still needed: ' + failures.join(', ') + '.');
    }
    if (hasCalculatedRef.current && !stale && !debounceRef.current) return;

    // Cancel any pending debounced recalculation so we calculate now instead of racing it.
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    // A superseded request resolves without rendering, so retry until one lands. Bounded,
    // because only a concurrent input change can supersede it.
    for (let i = 0; i < 3; i++) {
      if (await runCalculate()) return;
    }
    throw new Error('Could not refresh the report — please try again.');
  }, [stale, runCalculate]);

  const onDownload = useCallback(async () => {
    setDownloading(true);
    try {
      await ensureFresh();
      if (!captureRef.current) throw new Error('Report not ready. Please try again.');
      const pdf = await buildReportPdf(captureRef.current);
      pdf.save(reportFilename());
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Sentinel PDF export error:', e);
      alert(e instanceof Error ? e.message : 'PDF generation failed. Please try again.');
    } finally {
      setDownloading(false);
    }
  }, [ensureFresh]);

  const buildPdfDataUri = useCallback(async () => {
    await ensureFresh();
    if (!captureRef.current) throw new Error('Report not ready. Please try again.');
    const pdf = await buildReportPdf(captureRef.current);
    return pdf.output('datauristring');
  }, [ensureFresh]);

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
        missing={missing}
        warnings={warnings}
        onExtracted={onExtracted}
        onCalculate={onCalculate}
        calculating={calculating}
        gaps={gaps}
      />

      {result && (
        <div id="results" className={stale ? 'on stale' : 'on'} ref={resultsRef}>
          <hr />
          {/* Outside the capture area, so it never appears in the exported PDF. */}
          <div className="stale-strip">
            {calcError
              ? `Report is out of date — ${calcError}`
              : 'Inputs changed — updating report…'}
          </div>
          <ResultsReport
            result={result}
            customerName={snapshot.customerName}
            customerAddress={snapshot.customerAddress}
            captureRef={captureRef}
          />
          <div className="pdf-actions">
            <button
              className="pdf-btn"
              onClick={onDownload}
              disabled={downloading || !ready}
            >
              <DownloadIcon />
              {downloading ? 'Generating PDF…' : 'Download PDF report'}
            </button>
            <button
              className="pdf-btn email-btn"
              onClick={() => setEmailOpen(true)}
              disabled={!ready}
            >
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
