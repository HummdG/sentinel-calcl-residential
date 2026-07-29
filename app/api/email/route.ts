import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { getEmailConfig } from '@/lib/config';

export const runtime = 'nodejs';
export const maxDuration = 30;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const email = String(body.email ?? '').trim();
  const customerName = String(body.customerName ?? '').trim();
  const personalMessage = String(body.message ?? '').trim();
  const pdfBase64 = String(body.pdfBase64 ?? '');

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: 'Please enter a valid customer email address.' }, { status: 400 });
  }

  // Strip a data-URI prefix (data:application/pdf;...;base64,) if present.
  const commaIdx = pdfBase64.indexOf(',');
  const base64 = commaIdx >= 0 ? pdfBase64.slice(commaIdx + 1) : pdfBase64;

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = Buffer.from(base64, 'base64');
  } catch {
    return NextResponse.json({ error: 'The report could not be read. Please try again.' }, { status: 400 });
  }

  // Sanity-check: real PDF, and a plausible size (< 25 MB).
  if (pdfBuffer.length < 5 || pdfBuffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return NextResponse.json({ error: 'The attached file is not a valid PDF.' }, { status: 400 });
  }
  if (pdfBuffer.length > 25 * 1024 * 1024) {
    return NextResponse.json({ error: 'The report is too large to email.' }, { status: 400 });
  }

  const cfg = getEmailConfig();
  if (!cfg.host || !cfg.user || !cfg.pass) {
    return NextResponse.json(
      { error: 'Email is not configured on the server. Please download the report instead.' },
      { status: 500 }
    );
  }

  const greeting = cfg.body.replace(/\{customer_name\}/g, customerName || 'there');
  const text = personalMessage ? `${personalMessage}\n\n${greeting}` : greeting;

  const dateStr = new Date().toISOString().slice(0, 10);

  try {
    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
    });

    await transporter.sendMail({
      from: `"${cfg.fromName}" <${cfg.fromAddress}>`,
      to: email,
      subject: cfg.subject,
      text,
      attachments: [
        {
          filename: `Sentinel-Report-${dateStr}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not send the report.';
    return NextResponse.json({ error: message }, { status: 502 });
  }

  return NextResponse.json({ message: `Report sent to ${email}.` });
}
