import { formatUnits, parseUnits, type Address } from 'viem';
import { USDC_DECIMALS } from './constants';

export function formatUsdc(amount: bigint, opts: { decimals?: number } = {}): string {
  const s = formatUnits(amount, USDC_DECIMALS);
  const [int, frac = ''] = s.split('.');
  const decimals = opts.decimals ?? 2;
  const intGrouped = (int ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, "'"); // Swiss thousands separator
  if (decimals === 0) return intGrouped;
  return `${intGrouped}.${frac.padEnd(decimals, '0').slice(0, decimals)}`;
}

export function parseUsdc(input: string): bigint {
  const clean = input.replace(/['\s,]/g, '');
  if (!/^\d+(\.\d{0,6})?$/.test(clean)) throw new Error('Invalid amount');
  return parseUnits(clean, USDC_DECIMALS);
}

export function shortAddress(a: Address | string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'now';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d} day${d > 1 ? 's' : ''}${h ? ` ${h} h` : ''}`;
  if (h > 0) return `${h} h${m ? ` ${m} min` : ''}`;
  if (m > 0) return `${m} min${s ? ` ${s} s` : ''}`;
  return `${s} s`;
}

/** Demo delays are seconds; production delays are days. Show both to avoid confusing the audience. */
export const PRODUCTION_DELAYS = {
  recovery: '7 days',
  exit: '30 days',
  hold: '24 hours',
} as const;
