/**
 * Drives the real app in Chromium with a virtual WebAuthn authenticator (platform passkey with user
 * verification), plays the demo story and saves screenshots of the phone to docs/screenshots/.
 *
 *   npm run dev            (in another terminal; fresh state: npm run dev -- --fresh)
 *   npm run test:ui        (first time: npx playwright install chromium)
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'screenshots');
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (/^\d\d-.*\.png$|^failure\.png$/.test(f)) rmSync(join(OUT, f)); // keep strip.png
const APP = process.env.APP_URL ?? 'http://localhost:5173';

let n = 0;
async function shot(page: Page, name: string, full = false) {
  const file = join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`);
  if (full) await page.screenshot({ path: file, fullPage: true });
  else await page.locator('.phone').screenshot({ path: file });
  console.log(`  📸 ${file.replace(ROOT + '/', '')}`);
}

async function phone(ctx: BrowserContext, url: string) {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
  page.on('response', async (r) => {
    if (r.status() >= 400 && !r.url().includes('/health')) {
      console.log(`  [http ${r.status()}] ${r.url()} ${(await r.text().catch(() => '')).slice(0, 240)}`);
    }
  });
  await page.goto(url);
  return page;
}

const step = (s: string) => console.log(`\n▶ ${s}`);

async function rpc(method: string, params: unknown[]) {
  await fetch(process.env.RPC_URL ?? 'http://127.0.0.1:8545', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 980 } });

  step("Claire's phone: login and onboarding with a real WebAuthn passkey");
  const p1 = await phone(ctx, `${APP}/`);
  await p1.getByRole('button', { name: /Log in/ }).click();
  await p1.getByRole('button', { name: 'Create my wallet' }).waitFor();
  await shot(p1, 'onboarding-pact');
  await p1.getByRole('button', { name: 'Create my wallet' }).click();
  await p1.getByRole('button', { name: /Create with Face ID/ }).click();
  await p1.getByText('Print your recovery card').waitFor();
  await shot(p1, 'recovery-card');
  await p1.getByText('Skip the check (demo)').click();
  await p1.getByRole('button', { name: 'I have my card' }).click();
  await shot(p1, 'link-to-swissquote');
  await p1.getByRole('button', { name: /Sign with Face ID and create my wallet/ }).click();

  step('Funding from the Swissquote account (Travel Rule ownership already verified)');
  await p1.getByRole('button', { name: 'Move to my wallet now' }).click({ timeout: 30_000 });
  await p1.getByText('Sent instantly').waitFor({ timeout: 30_000 });
  await shot(p1, 'bank-travel-rule');

  step('Home');
  await p1.evaluate(() => (window.location.hash = '/'));
  await p1.getByText('Face ID alone, today').waitFor();
  await p1.waitForTimeout(3500);
  await shot(p1, 'home');

  step('Gasless payment with Face ID only');
  await p1.evaluate(() => (window.location.hash = '/send'));
  await p1.getByText('Marc Dubois').click();
  await p1.getByPlaceholder('0.00').fill('120');
  await p1.getByRole('button', { name: 'Review' }).click();
  await p1.getByRole('button', { name: 'Confirm with Face ID' }).waitFor();
  await shot(p1, 'sign-daily');
  await p1.getByRole('button', { name: 'Confirm with Face ID' }).click();
  await p1.getByText('Done').waitFor({ timeout: 30_000 });
  await shot(p1, 'sign-daily-done');
  await p1.getByRole('button', { name: 'Close' }).click();

  step('Vault transfer: Face ID + Swissquote (screened, simulated)');
  await p1.getByText('Marc Dubois').click();
  await p1.getByPlaceholder('0.00').fill('1500');
  await p1.getByRole('button', { name: 'Review' }).click();
  await p1.getByText('What you sign').waitFor();
  await p1.getByText('Simulation').waitFor({ timeout: 20_000 });
  await shot(p1, 'sign-vault-preview');
  await p1.getByRole('button', { name: /Face ID/ }).first().click();
  await p1.getByText(/Scheduled, not sent yet|Done/).waitFor({ timeout: 30_000 });
  await shot(p1, 'sign-vault-result');
  await p1.getByRole('button', { name: 'Close' }).click();

  step('Drainer refused by Swissquote');
  await p1.evaluate(() => (window.location.hash = '/dapps'));
  await p1.getByRole('button', { name: 'Claim 500 USDC' }).click();
  await p1.getByText(/will not co-sign|refused/i).first().waitFor({ timeout: 20_000 });
  await shot(p1, 'drainer-refused');
  await p1.keyboard.press('Escape');

  step('Radiographie: who can move my money?');
  await p1.evaluate(() => (window.location.hash = '/security'));
  await p1.getByText('Swissquote + La Poste').waitFor({ timeout: 20_000 });
  await shot(p1, 'security-radiography');

  step("Theft: Claire reports the phone stolen from a second phone, then links it with her card");
  const p2 = await phone(ctx, `${APP}/?device=new-phone`);
  current = p2;
  await p2.getByRole('button', { name: /Log in/ }).click();
  await p2.getByText('This phone is not linked to your wallet yet').waitFor({ timeout: 20_000 });
  await shot(p2, 'new-phone-choices');
  await p2.getByText('My phone was stolen: freeze now').click();
  await p2.getByRole('button', { name: 'Report stolen and freeze' }).click();
  await p2.getByText('Frozen', { exact: true }).waitFor({ timeout: 20_000 });
  await shot(p2, 'hotline-frozen');
  await p2.getByRole('button', { name: 'Back' }).click();
  await p2.getByText('New phone, I have my recovery card').click();
  await p2.getByRole('button', { name: /Create with Face ID/ }).click();
  await p2.getByText('(registered)').click();
  await p2.getByRole('button', { name: 'Claire’s face' }).click();
  await p2.getByText('Face ID alone, today').waitFor({ timeout: 40_000 });
  await shot(p2, 'new-phone-linked');

  step("The stolen phone is now worthless");
  await p1.reload();
  await p1.getByText('This phone no longer controls the wallet').waitFor({ timeout: 20_000 });
  await shot(p1, 'stolen-phone-removed');

  step('Lost EVERYTHING: a third phone, video identification + La Poste letter');
  const p3 = await phone(ctx, `${APP}/?device=third-phone`);
  current = p3;
  await p3.getByRole('button', { name: /Log in/ }).click();
  await p3.getByText('I lost my phone and my card').click();
  await p3.getByRole('button', { name: /Create with Face ID/ }).click();
  await p3.getByRole('button', { name: 'I have printed it' }).click();
  await p3.getByRole('button', { name: 'Claire’s face' }).click();
  await p3.getByText('La Poste sent you a registered letter').waitFor({ timeout: 30_000 });
  await shot(p3, 'guardian-letter-sent');
  const mailbox = await ctx.newPage();
  await mailbox.goto(`${APP}/#/mailbox`);
  const code = (await mailbox.locator('.letter-code strong').first().textContent({ timeout: 20_000 }))!.trim();
  await shot(mailbox, 'mailbox-letter', true);
  await p3.getByPlaceholder('XXXX-XXXX').fill(code);
  await p3.getByRole('button', { name: 'Confirm and start the recovery' }).click();
  await p3.getByText('Recovery in progress').waitFor({ timeout: 30_000 });
  await shot(p3, 'guardian-recovering');
  await p2.getByText('A recovery of your wallet is in progress.').waitFor({ timeout: 20_000 });
  await shot(p2, 'owner-alerted');
  // The demo jumps the local chain clock over the recovery delay; the watchtower then finalizes it.
  await rpc('evm_increaseTime', [200]);
  await rpc('evm_mine', []);
  await p3.getByText('Face ID alone, today').waitFor({ timeout: 60_000 });
  await shot(p3, 'guardian-recovered');

  step('Mailbox and back-office');
  const ops = await ctx.newPage();
  await ops.goto(`${APP}/#/ops`);
  await ops.getByText('Back-office').waitFor();
  await ops.waitForTimeout(2500);
  await shot(ops, 'ops-video-ident', true);

  step('Swissquote is gone: the exit app with the paper card only');
  const words = await p2.evaluate(() => {
    const cards = JSON.parse(localStorage.getItem('rutli:demo-cards') ?? '[]') as Array<{ words: string }>;
    return cards[0]?.words ?? '';
  });
  const exit = await ctx.newPage();
  current = exit;
  await exit.goto(process.env.EXIT_URL ?? 'http://localhost:5174');
  await exit.getByRole('button', { name: 'Connect' }).click();
  await exit.getByText(/Connected to chain/).first().waitFor();
  await exit.locator('#words').fill(words);
  await exit.getByRole('button', { name: 'Use this card' }).click();
  await exit.getByText(/Found 1 wallet/).waitFor({ timeout: 30_000 });
  await exit.getByRole('button', { name: /give the card 0.01 ETH/ }).click();
  await exit.getByRole('button', { name: 'Start the exit' }).click();
  await exit.getByText(/Exit pending/).waitFor({ timeout: 30_000 });
  await shot(exit, 'exit-app-pending', true);
  await exit.getByRole('button', { name: /jump/ }).click();
  await exit.getByRole('button', { name: 'Finalize the exit' }).click({ timeout: 30_000 });
  await exit.getByText(/Sovereign: your card has full control/).waitFor({ timeout: 30_000 });
  await exit.locator('#dest').fill('0x000000000000000000000000000000000000bEEF');
  await exit.getByRole('button', { name: 'Sweep all' }).click();
  await exit.getByText(/Sweep confirmed/).waitFor({ timeout: 30_000 });
  await shot(exit, 'exit-app-swept', true);

  await browser.close();
  console.log('\n✔ UI story passed');
}

let current: Page | undefined;
main().catch(async (e) => {
  console.error(e);
  if (current) await current.screenshot({ path: join(OUT, 'failure.png') }).catch(() => undefined);
  process.exit(1);
});
