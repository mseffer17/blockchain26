import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The exit app must work without any Swissquote server: everything is bundled into ONE html file.
// The default RPC is only a convenience; the user can type any public RPC.
const local = '../deployments/local.json';
const defaultRpc = process.env.EXIT_DEFAULT_RPC ?? (existsSync(local) ? JSON.parse(readFileSync(local, 'utf8')).rpcUrl : 'https://sepolia.base.org');

export default defineConfig({
  plugins: [viteSingleFile()],
  define: { __DEFAULT_RPC__: JSON.stringify(defaultRpc) },
  server: { port: 5174, strictPort: true, host: 'localhost' },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
});
