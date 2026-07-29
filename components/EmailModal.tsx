'use client';

import { useEffect, useState } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  customerName: string;
  buildPdfDataUri: () => Promise<string>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function EmailModal({ open, onClose, customerName, buildPdfDataUri }: Props) {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<{ cls: string; msg: string }>({ cls: '', msg: '' });
  const [sending, setSending] = useState(false);
  const [sendLabel, setSendLabel] = useState('Send report');

  useEffect(() => {
    if (open) {
      setStatus({ cls: '', msg: '' });
      setSending(false);
      setSendLabel('Send report');
    }
  }, [open]);

  async function send() {
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setStatus({ cls: 'error', msg: 'Please enter a valid customer email address.' });
      return;
    }

    setSending(true);
    setSendLabel('Generating PDF…');
    setStatus({ cls: 'loading', msg: 'Generating report…' });

    try {
      const dataUri = await buildPdfDataUri();
      setSendLabel('Sending…');
      setStatus({ cls: 'loading', msg: `Sending to ${trimmed}…` });

      const res = await fetch('/api/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: trimmed,
          message: message.trim(),
          customerName,
          pdfBase64: dataUri,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Email failed.');

      setStatus({ cls: 'success', msg: data.message || 'Report sent.' });
      setSendLabel('Sent');
      setTimeout(onClose, 1800);
    } catch (e) {
      setStatus({
        cls: 'error',
        msg: e instanceof Error ? e.message : 'Could not send the report. Please try again.',
      });
      setSending(false);
      setSendLabel('Send report');
    }
  }

  return (
    <div className={`email-modal${open ? ' open' : ''}`} aria-hidden={!open}>
      <div className="email-modal-backdrop" onClick={onClose} />
      <div className="email-modal-card" role="dialog" aria-labelledby="emailModalTitle" aria-modal="true">
        <div className="email-modal-head">
          <h2 id="emailModalTitle">Email PDF report</h2>
          <button type="button" className="email-modal-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="email-modal-body">
          <div className="field">
            <label htmlFor="emailCustomerEmail">Customer email</label>
            <div className="frow">
              <input
                id="emailCustomerEmail"
                type="email"
                placeholder="customer@example.com"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="emailPersonalMessage">
              Personal message{' '}
              <span
                style={{
                  textTransform: 'none',
                  letterSpacing: 0,
                  fontWeight: 400,
                  color: 'var(--hs-muted)',
                  fontStyle: 'italic',
                }}
              >
                optional
              </span>
            </label>
            <textarea
              id="emailPersonalMessage"
              rows={3}
              placeholder="Add a short note to the customer (optional)."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
          <div className={`email-modal-status ${status.cls}`.trim()}>{status.msg}</div>
        </div>
        <div className="email-modal-foot">
          <button type="button" className="email-modal-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="email-modal-send"
            onClick={send}
            disabled={sending || sendLabel === 'Sent'}
          >
            {sendLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
