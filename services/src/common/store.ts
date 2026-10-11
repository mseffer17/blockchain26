import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NETWORK, REPO_ROOT, type ServiceName } from './config';

/** Every mocked institution has its own data directory: services/data/<network>/<service>/. */
export function dataDir(service: ServiceName): string {
  const dir = join(REPO_ROOT, 'services', 'data', NETWORK, service);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Minimal JSON document store with atomic writes (write to a temp file, then rename).
 * One file per service, never shared: the separation the challenge requires for mocked share holders.
 */
export class JsonStore<T extends object> {
  private readonly file: string;
  data: T;

  constructor(service: ServiceName, name: string, initial: () => T) {
    this.file = join(dataDir(service), `${name}.json`);
    this.data = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as T) : initial();
    this.save();
  }

  save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    renameSync(tmp, this.file);
  }

  update<R>(fn: (data: T) => R): R {
    const r = fn(this.data);
    this.save();
    return r;
  }
}
