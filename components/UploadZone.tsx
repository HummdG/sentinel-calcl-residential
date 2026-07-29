'use client';

import { useRef, useState } from 'react';
import { extractPdfText } from '@/lib/pdf-extract';
import type { ExtractedFields } from '@/lib/types';

const MAX_MB = Number(process.env.NEXT_PUBLIC_MAX_UPLOAD_MB) || 20;

interface Props {
  onExtracted: (fields: ExtractedFields) => void;
}

export default function UploadZone({ onExtracted }: Props) {
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
      if (!text.trim()) {
        throw new Error('Could not read any text from the PDF. Please enter values manually.');
      }

      const res = await fetch('/api/parse-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Extraction failed.');
      }

      onExtracted(data.fields as ExtractedFields);
      setStatus({
        cls: 'success',
        msg:
          data.message ||
          `✓ Extracted ${data.populated_count} values. Review and adjust if needed, then click Calculate.`,
      });
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
        <p className="upload-title">Drop OpenSolar PDF here or click to browse</p>
        <p className="upload-sub">Key figures will be extracted automatically</p>
      </div>
      <div className={`upload-status ${status.cls}`.trim()}>{status.msg}</div>
    </>
  );
}
