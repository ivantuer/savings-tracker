// Passkeys with the WebAuthn PRF extension: the passkey yields a stable 32-byte secret that never leaves the device.
// The secret is derived on each device that holds the passkey (iCloud Keychain and Google Password Manager sync passkeys).
const te = new TextEncoder();
const SALT = te.encode('savings-tracker/prf/v1');

export const passkeysAvailable = () => typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;

/**
 * Whether this browser can derive a secret from a passkey (the PRF extension).
 * 'unknown' means the browser cannot say; trying is the only way to find out.
 */
export async function prfCapability(): Promise<'yes' | 'no' | 'unknown'> {
  if (!passkeysAvailable()) return 'no';
  try {
    const caps = await (PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> }).getClientCapabilities?.();
    if (!caps || !('extension:prf' in caps)) return 'unknown';
    return caps['extension:prf'] ? 'yes' : 'no';
  } catch {
    return 'unknown';
  }
}

const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n));

const UNSUPPORTED = 'This device or browser cannot use a passkey for encryption (it lacks the PRF feature). Use Google instead.';

function explain(e: unknown): Error {
  if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError'))
    return new Error('The passkey prompt was cancelled, or no passkey for this app was found on this device.');
  return e instanceof Error ? e : new Error('Passkey failed');
}

/** Creates a passkey for this app on this device (first device only). Throws if it cannot be used for encryption. */
export async function createPasskey(): Promise<void> {
  try {
    const cred = (await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Savings Tracker', id: location.hostname },
        user: { id: rnd(16), name: 'savings-tracker', displayName: 'Savings Tracker' },
        challenge: rnd(32),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    const prf = (cred?.getClientExtensionResults() as { prf?: { enabled?: boolean } } | undefined)?.prf;
    if (!cred || prf?.enabled === false) throw new Error(UNSUPPORTED);
  } catch (e) {
    throw explain(e);
  }
}

/** Asks the user to approve with Face ID / Touch ID / PIN and returns the passkey's secret. */
export async function passkeySecret(): Promise<Uint8Array> {
  try {
    const cred = (await navigator.credentials.get({
      publicKey: {
        challenge: rnd(32),
        rpId: location.hostname,
        userVerification: 'required',
        timeout: 60_000,
        extensions: { prf: { eval: { first: SALT } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    const out = (cred?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } } | undefined)?.prf?.results?.first;
    if (!out) throw new Error(UNSUPPORTED);
    return new Uint8Array(out);
  } catch (e) {
    throw explain(e);
  }
}
