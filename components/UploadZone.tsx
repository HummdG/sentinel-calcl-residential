'use client';

import { useRef, useState } from 'react';
import { extractPdfText } from '@/lib/pdf-extract';
import { renderPages } from '@/lib/pdf-render';
import type { PdfDocumentRef } from '@/lib/extract/anthropic';
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

/**
 * Upload the proposal so the model can read the PDF itself. A file over the request-size
 * cap is split into page ranges first (lib/pdf-split.ts, loaded only when needed).
 * Throws when it cannot be done; the caller then falls back to the text pipeline.
 */
async function uploadProposal(file: File): Promise<PdfDocumentRef[]> {
  const { splitPdf } = await import('@/lib/pdf-split');
  const parts = await splitPdf(new Uint8Array(await file.arrayBuffer()));

  const h: Record<string, string> = { 'Content-Type': 'application/pdf' };
  if (EXTRACT_KEY) h['x-extract-key'] = EXTRACT_KEY;

  const results = await Promise.allSettled(
    parts.map(async (part) => {
      const res = await fetch('/api/parse-pdf/upload', {
        method: 'POST',
        headers: h,
        body: new Blob([part.bytes as BlobPart], { type: 'application/pdf' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed.');
      return { fileId: data.fileId as string, firstPage: part.firstPage, lastPage: part.lastPage };
    })
  );

  const uploaded = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  if (uploaded.length < parts.length) {
    // Do not leave the parts that did make it behind.
    removeUploads(uploaded);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    throw failed.reason;
  }
  return uploaded;
}

/** Best effort: the server also deletes on its own terminal path. */
function removeUploads(documents: PdfDocumentRef[]): void {
  if (!documents.length) return;
  fetch('/api/parse-pdf/cleanup', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ fileIds: documents.map((d) => d.fileId) }),
    keepalive: true,
  }).catch(() => {});
}

export default function UploadZone({ onExtracted, warnings }: Props) {
  const [status, setStatus] = useState<{ cls: string; msg: string }>({ cls: '', msg: '' });
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Run tier 1, then tier 2 if it asked for a second look, and show the better result.
   * `secondBody` builds tier 2's request from tier 1's answer.
   */
  async function runTiers(
    firstBody: Record<string, unknown>,
    secondBody: (first: ParsedPdfResponse) => Promise<Record<string, unknown>>
  ) {
    // Tier 1: fast and cheap. Show it immediately. Most uploads stop here.
    const first = await post('/api/parse-pdf', firstBody);
    onExtracted(first);
    setStatus({ cls: first.escalate ? 'loading' : 'success', msg: first.message });

    if (!first.escalate) return;

    // Tier 2: the stronger model.
    const second = await post('/api/parse-pdf/escalate', await secondBody(first));

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
  }

  /**
   * The normal path: the model reads the uploaded PDF, laid out, in both tiers. The pdf.js
   * text still goes along, but only so the server can check the model's quotes.
   */
  async function readFromPdf(text: string, documents: PdfDocumentRef[]) {
    if (!text.trim()) {
      // A scan. There is no text to check quotes against, so go straight to the
      // stronger model, which reads the page images inside the PDF.
      setStatus({
        cls: 'loading',
        msg: 'This looks like a scanned proposal. Reading the pages directly…',
      });
      const scanned = await post('/api/parse-pdf/escalate', { text: '', documents });
      onExtracted(scanned);
      setStatus({ cls: 'success', msg: scanned.message });
      return;
    }
    // Tier 2 re-reads the same upload with the stronger model; nothing is sent again.
    await runTiers({ text, documents }, async () => ({ text, documents }));
  }

  /**
   * The fallback, for a PDF that could not be uploaded (over 100 pages, a single page
   * over the size cap, or an upload error): the model reads the pdf.js text, and the
   * second tier gets rendered images of the pages that failed verification.
   */
  async function readFromText(file: File, text: string) {
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
    await runTiers({ text }, async (first) => {
      // Re-read the pages the verifier rejected, as images.
      const priority = first.provenance
        .filter((p) => p.status === 'unverified' && p.page !== null)
        .map((p) => p.page as number);
      const images = await renderPages(file, priority);
      return { text, pageImages: images };
    });
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;

    if (file.size > MAX_MB * 1024 * 1024) {
      setStatus({ cls: 'error', msg: `File is too large. Maximum size is ${MAX_MB} MB.` });
      return;
    }

    setStatus({ cls: 'loading', msg: 'Reading the proposal… this takes a few seconds.' });

    let documents: PdfDocumentRef[] = [];
    try {
      const text = await extractPdfText(file);

      try {
        documents = await uploadProposal(file);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('Sentinel: could not upload the PDF, reading its text instead.', e);
      }

      if (documents.length) {
        try {
          await readFromPdf(text, documents);
          return;
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('Sentinel: reading the PDF failed, falling back to its text.', e);
        }
      }
      await readFromText(file, text);
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
    } finally {
      removeUploads(documents);
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
