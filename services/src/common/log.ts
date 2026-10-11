const COLORS: Record<string, string> = {
  'sq-core': '\x1b[34m',
  'sq-cosigner': '\x1b[35m',
  'poste-guardian': '\x1b[33m',
  'video-ident': '\x1b[36m',
  'gas-station': '\x1b[32m',
  watchtower: '\x1b[90m',
};

export function logger(service: string) {
  const c = COLORS[service] ?? '';
  const reset = '\x1b[0m';
  const ts = () => new Date().toISOString().slice(11, 19);
  return {
    info: (...a: unknown[]) => console.log(`${c}[${ts()} ${service}]${reset}`, ...a),
    warn: (...a: unknown[]) => console.warn(`${c}[${ts()} ${service}]${reset} \x1b[33mWARN\x1b[0m`, ...a),
    error: (...a: unknown[]) => console.error(`${c}[${ts()} ${service}]${reset} \x1b[31mERROR\x1b[0m`, ...a),
  };
}
