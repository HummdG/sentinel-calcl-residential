// SERVER-ONLY configuration.
//
// Mirrors admin/class-settings-page.php::raw_defaults() from the WordPress plugin.
// Every business constant has a default in code, overridable by a SENTINEL_* env
// var. Secrets (Groq key, SMTP credentials) have no defaults. Because all
// calculations run in server route handlers, none of this is ever shipped to the
// browser.

import type { Tariff, Usage } from './types';

function envNum(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface Constants {
  peak_shaving_per_kwh: number;
  trading_per_kwh: number;
  iep_fee: number;
  sentinel_fee: number;
  sub: number;
  export_base_standard: number; // £/kWh
  export_sentinel_flux: number; // £/kWh
  flux_charge_rate: number; // £/kWh
  tm: Record<Tariff, number>;
  um: Record<Usage, number>;
  bill_up: Record<Tariff, number>;
  mw: number[];
}

const DEFAULT_MW = [
  0.0348, 0.0487, 0.081, 0.1052, 0.1288, 0.1328, 0.1335, 0.117, 0.0886, 0.0626,
  0.0382, 0.0294,
];

export function getConstants(): Constants {
  const mwEnv = process.env.SENTINEL_MONTHLY_WEIGHTS;
  let mw = DEFAULT_MW;
  if (mwEnv && mwEnv.trim() !== '') {
    const parsed = mwEnv.split(',').map((s) => Number.parseFloat(s.trim()));
    if (parsed.length === 12 && parsed.every((n) => Number.isFinite(n))) {
      mw = parsed;
    }
  }

  return {
    peak_shaving_per_kwh: envNum(process.env.SENTINEL_PEAK_SHAVING_PER_KWH, 47.0),
    trading_per_kwh: envNum(process.env.SENTINEL_TRADING_PER_KWH, 13.0),
    iep_fee: envNum(process.env.SENTINEL_IEP_FEE, 0.2),
    sentinel_fee: envNum(process.env.SENTINEL_SENTINEL_FEE, 0.2),
    sub: envNum(process.env.SENTINEL_SUB, 199.0),
    export_base_standard: envNum(process.env.SENTINEL_EXPORT_BASE_STANDARD, 0.055),
    export_sentinel_flux: envNum(process.env.SENTINEL_EXPORT_SENTINEL_FLUX, 0.22),
    flux_charge_rate: envNum(process.env.SENTINEL_FLUX_CHARGE_RATE, 0.07),
    tm: {
      standard: envNum(process.env.SENTINEL_TM_STANDARD, 1.0),
      daynight: envNum(process.env.SENTINEL_TM_DAYNIGHT, 1.2),
      flux: envNum(process.env.SENTINEL_TM_FLUX, 1.4),
    },
    um: {
      daytime: envNum(process.env.SENTINEL_UM_DAYTIME, 0.75),
      balanced: envNum(process.env.SENTINEL_UM_BALANCED, 1.0),
      evening: envNum(process.env.SENTINEL_UM_EVENING, 1.2),
    },
    bill_up: {
      standard: envNum(process.env.SENTINEL_BILL_UP_STANDARD, 0.08),
      daynight: envNum(process.env.SENTINEL_BILL_UP_DAYNIGHT, 0.14),
      flux: envNum(process.env.SENTINEL_BILL_UP_FLUX, 0.17),
    },
    mw,
  };
}

export interface GroqConfig {
  apiKey: string;
  model: string;
  maxChars: number;
}

export function getGroqConfig(): GroqConfig {
  return {
    apiKey: process.env.GROQ_API_KEY ?? '',
    model: process.env.GROQ_MODEL?.trim() || 'llama-3.3-70b-versatile',
    maxChars: envInt(process.env.GROQ_MAX_CHARS, 120000),
  };
}

const DEFAULT_MAIL_BODY =
  'Hi {customer_name},\n\nPlease find attached your personalised Sentinel EMS Savings Report, prepared by HSEnergy following your survey.\n\nThis report shows the projected financial benefit of adding Sentinel EMS to your solar and battery system, based on the figures we discussed.\n\nIf you have any questions, please don\'t hesitate to get in touch.\n\nKind regards,\nHSEnergy Group Ltd';

export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromAddress: string;
  fromName: string;
  subject: string;
  body: string;
}

export function getEmailConfig(): EmailConfig {
  // \n in a dashboard-set env var arrives literally; turn it into a real newline.
  const rawBody = process.env.MAIL_BODY;
  const body = rawBody && rawBody.trim() !== '' ? rawBody.replace(/\\n/g, '\n') : DEFAULT_MAIL_BODY;

  return {
    host: process.env.SMTP_HOST ?? '',
    port: envInt(process.env.SMTP_PORT, 587),
    secure: (process.env.SMTP_SECURE ?? 'false').toLowerCase() === 'true',
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    fromAddress: process.env.MAIL_FROM?.trim() || 'info@hsenergy.co.uk',
    fromName: process.env.MAIL_FROM_NAME?.trim() || 'HSEnergy',
    subject:
      process.env.MAIL_SUBJECT?.trim() || 'Your Sentinel EMS Savings Report from HSEnergy',
    body,
  };
}
