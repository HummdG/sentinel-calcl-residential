'use client';

import { useRef, useState } from 'react';
import { extractPdfText } from '@/lib/pdf-extract';
import { renderPages } from '@/lib/pdf-render';
import type { ParsedPdfResponse } from '@/lib/types';

const MAX_MB = Number(process.env.NEXT_PUBLIC_MAX_UPLOAD_MB) || 20;
const EXTRACT_KEY = process.env.NEXT_PUBLIC_EXTRACT_KEY ?? '';

interface Props {
  onExtracted: (data: ParsedPdfResponse) => void;
  warnings: string[];
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (EXTRACT_KEY) h['x-extract-key'] = EXTRACT_KEY;
  return h;
}

async function post(url: string, body: unknown): Promise<ParsedPdfResponse> {
  const res = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Extraction failed.');
  return data as ParsedPdfResponse;
}

export default function UploadZone({ onExtracted, warnings }: Props) {
  const [status, setStatus] = useState<{ cls: string; msg: string }>({ cls: '', msg: '' });
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File | undefined) {
    if (!file) return;

    if (file.size > MAX_MB * 1024 * 1024) {
      setStatus({ cls: 'error', msg: `File is too large. Maximum size is ${MAX_MB} MB.` });
      return;
    }

    setStatus({ cls: 'loading', msg: 'Reading the proposal… this takes a few seconds.' });

    try {
      const text = await extractPdfText(file);

      // No text layer at all, a scanned proposal. Tier 1 has nothing to work from, so go
      // straight to the vision tier rather than failing the way this used to.
      if (!text.trim()) {
        setStatus({
          cls: 'loading',
          msg: 'This looks like a scanned proposal. Reading the pages directly…',
        });
        const images = await renderPages(file);
        if (!images.length) {
          throw new Error('Could not read this PDF at all. Please enter the values manually.');
        }
        const scanned = await post('/api/parse-pdf/escalate', { text: '', pageImages: images });
        onExtracted(scanned);
        setStatus({ cls: 'success', msg: scanned.message });
        return;
      }

      // Tier 1: fast and cheap. Show it immediately. Most uploads stop here.
      const first = await post('/api/parse-pdf', { text });
      onExtracted(first);
      setStatus({
        cls: first.escalate ? 'loading' : 'success',
        msg: first.message,
      });

      if (!first.escalate) return;

      // Tier 2: re-read the pages the verifier rejected, as images.
      const priority = first.provenance
        .filter((p) => p.status === 'unverified' && p.page !== null)
        .map((p) => p.page as number);

      const images = await renderPages(file, priority);
      const second = await post('/api/parse-pdf/escalate', { text, pageImages: images });

      // Only accept the escalation if it actually did better. A second opinion that
      // confirms fewer fields is not an improvement worth overwriting the first with.
      if (second.populated_count >= first.populated_count) {
        onExtracted(second);
        setStatus({ cls: 'success', msg: second.message });
      } else {
        setStatus({
          cls: 'success',
          msg: `${first.message} A second pass did not add anything further.`,
        });
      }
    } catch (e) {
      setStatus({
        cls: 'error',
        msg:
          e instanceof Error
            ? e.message
            : 'Could not extract figures automatically. Please enter values manually below.',
      });
      // eslint-disable-next-line no-console
      console.error('Sentinel PDF parse error:', e);
    }
  }

  return (
    <>
      <div
        className={`upload-zone${drag ? ' drag' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files[0];
          if (f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name))) {
            handleFile(f);
          }
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
        <span className="upload-icon">📄</span>
        <p className="upload-title">Drop a solar proposal PDF here or click to browse</p>
        <p className="upload-sub">Key figures will be extracted automatically</p>
      </div>
      <div className={`upload-status ${status.cls}`.trim()}>{status.msg}</div>
      {/* Advisory only. These never block Calculate; the completeness gate does that. */}
      {warnings.length > 0 && (
        <ul className="upload-warnings">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </>
  );
}
