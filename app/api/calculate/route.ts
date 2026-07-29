import { NextResponse } from 'next/server';
import { calculate } from '@/lib/calculator';
import { getConstants } from '@/lib/config';
import type { CalcInput, Tariff, Usage } from '@/lib/types';

export const runtime = 'nodejs';

const TARIFFS: Tariff[] = ['standard', 'daynight', 'flux'];
const USAGES: Usage[] = ['daytime', 'balanced', 'evening'];

function num(v: unknown): number {
  const n = Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const tariff = TARIFFS.includes(body.tariff as Tariff) ? (body.tariff as Tariff) : 'standard';
  const usage = USAGES.includes(body.usage as Usage) ? (body.usage as Usage) : 'balanced';

  const input: CalcInput = {
    pv_size: num(body.pv_size),
    battery_kwh: num(body.battery_kwh),
    inverter_kw: num(body.inverter_kw),
    annual_gen: num(body.annual_gen),
    annual_usage: num(body.annual_usage),
    system_cost: num(body.system_cost),
    solar_savings: num(body.solar_savings),
    export_kwh: num(body.export_kwh),
    os_payback: num(body.os_payback),
    os_25yr: num(body.os_25yr),
    os_roi: num(body.os_roi),
    std_import: num(body.std_import),
    dn_day: num(body.dn_day),
    dn_night: num(body.dn_night),
    tariff,
    usage,
    inflation: num(body.inflation),
  };

  const result = calculate(input, getConstants());
  return NextResponse.json(result);
}
