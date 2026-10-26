import crypto from 'node:crypto';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { decrypt, encrypt } from '../../lib/crypto';
import { badRequest } from '../../lib/http';
import { hashToken } from '../../lib/tokens';
import type { UserDoc } from '../../models/User';

// Accept the previous/next 30s step to tolerate clock drift.
authenticator.options = { window: 1 };

const RECOVERY_CODE_COUNT = 8;

/** Generate a secret, store it as pending (encrypted), and return what the authenticator app needs. */
export async function beginSetup(
  user: UserDoc,
): Promise<{ otpauthUrl: string; qrDataUrl: string; secret: string }> {
  const secret = authenticator.generateSecret();
  user.twoFactor.pendingSecretEnc = encrypt(secret);
  await user.save();
  const otpauthUrl = authenticator.keyuri(user.email, 'Keyless', secret);
  return { otpauthUrl, qrDataUrl: await QRCode.toDataURL(otpauthUrl), secret };
}

/** Confirm the pending secret with a code; returns single-use recovery codes (shown once). */
export async function confirmSetup(user: UserDoc, code: string): Promise<string[]> {
  if (!user.twoFactor.pendingSecretEnc) throw badRequest('Start two-factor setup first');
  const secret = decrypt(user.twoFactor.pendingSecretEnc);
  if (!authenticator.verify({ token: code, secret }))
    throw badRequest('That code is not valid', 'INVALID_CODE');

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = crypto.randomBytes(5).toString('hex');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  user.twoFactor.enabled = true;
  user.twoFactor.secretEnc = user.twoFactor.pendingSecretEnc;
  user.twoFactor.pendingSecretEnc = undefined;
  user.twoFactor.recoveryCodeHashes = codes.map(hashToken);
  await user.save();
  return codes;
}

export async function disable(user: UserDoc): Promise<void> {
  user.twoFactor.enabled = false;
  user.twoFactor.secretEnc = undefined;
  user.twoFactor.pendingSecretEnc = undefined;
  user.twoFactor.recoveryCodeHashes = [];
  await user.save();
}

/** Check a TOTP code or consume a recovery code. */
export async function verifyLoginCode(user: UserDoc, code: string): Promise<boolean> {
  if (!user.twoFactor.enabled || !user.twoFactor.secretEnc) return false;
  const normalised = code.replace(/\s/g, '').toLowerCase();
  if (/^\d{6}$/.test(normalised)) {
    return authenticator.verify({ token: normalised, secret: decrypt(user.twoFactor.secretEnc) });
  }
  const hash = hashToken(normalised);
  const idx = user.twoFactor.recoveryCodeHashes.indexOf(hash);
  if (idx === -1) return false;
  user.twoFactor.recoveryCodeHashes.splice(idx, 1);
  await user.save();
  return true;
}
