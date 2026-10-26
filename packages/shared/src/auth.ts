import { z } from 'zod';
import { roleSchema } from './roles';

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

// 10+ chars; length beats composition rules (NCSC / NIST guidance).
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200, 'Password is too long');

export const signupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: emailSchema,
  password: passwordSchema,
  organizationName: z.string().trim().min(1).max(120),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code');

export const loginTwoFactorSchema = z.object({
  challengeToken: z.string().min(1),
  /** A 6-digit authenticator code, or one of the single-use recovery codes. */
  code: z.string().trim().min(6).max(32),
});

export const tokenSchema = z.object({ token: z.string().min(1).max(200) });

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(1).max(200),
  password: passwordSchema,
});

export const acceptInviteSchema = z.object({
  token: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(100),
  password: passwordSchema,
});

export const enableTwoFactorSchema = z.object({ code: totpCodeSchema });
export const disableTwoFactorSchema = z.object({ password: z.string().min(1).max(200) });

export const userDtoSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  email: z.string(),
  role: roleSchema,
  emailVerified: z.boolean(),
  twoFactorEnabled: z.boolean(),
  isSuperAdmin: z.boolean(),
  createdAt: z.string(),
});
export type UserDto = z.infer<typeof userDtoSchema>;

export const organizationDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  country: z.string(),
  timezone: z.string(),
  currency: z.string(),
  plan: z.string(),
});
export type OrganizationDto = z.infer<typeof organizationDtoSchema>;

export type MeResponse = { user: UserDto; organization: OrganizationDto };

/** Login either completes or asks for a TOTP code. */
export type LoginResponse =
  ({ status: 'ok' } & MeResponse) | { status: 'two_factor_required'; challengeToken: string };
