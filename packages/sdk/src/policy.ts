import { toFunctionSelector, getAbiItem, type Hex } from 'viem';
import { rutliAccountAbi } from './abis';
import { Factor } from './constants';

const sel = (name: string): Hex =>
  toFunctionSelector(getAbiItem({ abi: rutliAccountAbi, name: name as never }) as never) as Hex;

export const SELECTORS = {
  spend: sel('spend'),
  execute: sel('execute'),
  executeBatch: sel('executeBatch'),
  rotatePasskey: sel('rotatePasskey'),
  rotateCard: sel('rotateCard'),
  setCosigner: sel('setCosigner'),
  setGuardian: sel('setGuardian'),
  setAllowance: sel('setAllowance'),
  setDelays: sel('setDelays'),
  freeze: sel('freeze'),
  unfreeze: sel('unfreeze'),
  initiateRecovery: sel('initiateRecovery'),
  cancelRecovery: sel('cancelRecovery'),
  initiateExit: sel('initiateExit'),
  cancelExit: sel('cancelExit'),
} as const;

const { PASSKEY: P, CARD: C, COSIGNER: S, GUARDIAN: G } = Factor;

/** Who: the factor combinations shown in the Radiographie ("who can move my money?"). */
export const RADIOGRAPHY_ACTORS = [
  { id: 'P', mask: P, label: 'You (Face ID)', who: 'client' },
  { id: 'PS', mask: P | S, label: 'You + Swissquote', who: 'client' },
  { id: 'PC', mask: P | C, label: 'You + your card', who: 'client' },
  { id: 'CS', mask: C | S, label: 'Your card + Swissquote', who: 'client' },
  { id: 'C', mask: C, label: 'Your card alone', who: 'client' },
  { id: 'SG', mask: S | G, label: 'Swissquote + La Poste', who: 'institutions' },
  { id: 'S', mask: S, label: 'Swissquote alone', who: 'institutions' },
  { id: 'G', mask: G, label: 'La Poste alone', who: 'institutions' },
] as const;

/** What: the actions, each mapped to the on-chain selector that `canAuthorize` is queried with. */
export const RADIOGRAPHY_ACTIONS = [
  { id: 'spend', selector: SELECTORS.spend, label: 'Spend the daily wallet', delay: 'none' as const, note: 'daily limit' },
  { id: 'execute', selector: SELECTORS.execute, label: 'Move vault funds / use dApps', delay: 'none' as const },
  { id: 'rotatePasskey', selector: SELECTORS.rotatePasskey, label: 'Replace your passkey', delay: 'none' as const },
  { id: 'rotateCard', selector: SELECTORS.rotateCard, label: 'Replace your card', delay: 'none' as const },
  { id: 'recovery', selector: SELECTORS.initiateRecovery, label: 'Start a recovery', delay: 'recovery' as const },
  { id: 'exit', selector: SELECTORS.initiateExit, label: 'Start an exit', delay: 'exit' as const },
  { id: 'freeze', selector: SELECTORS.freeze, label: 'Freeze Face-ID spending', delay: 'none' as const },
  { id: 'cancel', selector: SELECTORS.cancelRecovery, label: 'Cancel a recovery', delay: 'none' as const },
] as const;

/** The custody statement, derived from live answers of `canAuthorize` (true = allowed). */
export function custodyVerdict(answers: Record<string, Record<string, boolean>>): {
  institutionsCanMoveFunds: boolean;
  institutionsCanReplaceKeysInstantly: boolean;
  clientCanActWithoutSwissquote: boolean;
} {
  const inst = ['S', 'G', 'SG'];
  return {
    institutionsCanMoveFunds: inst.some((a) => answers[a]?.spend || answers[a]?.execute),
    institutionsCanReplaceKeysInstantly: inst.some((a) => answers[a]?.rotatePasskey || answers[a]?.rotateCard),
    clientCanActWithoutSwissquote: !!answers['PC']?.execute,
  };
}
