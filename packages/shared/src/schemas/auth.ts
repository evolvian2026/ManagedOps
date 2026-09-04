import { z } from 'zod';
import { ROLES } from '../enums.js';
import { emailSchema, phoneSchema } from './common.js';

/**
 * Password policy: length does more for entropy than character-class rules, so
 * the floor is 12 characters with a light complexity check to catch the worst
 * choices, and generated temporary passwords comfortably clear it.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(128, 'Use at most 128 characters')
  .refine(
    (value) => /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value),
    'Include an uppercase letter, a lowercase letter and a number',
  );

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password'),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: passwordSchema,
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    path: ['newPassword'],
    message: 'Choose a password different from your current one',
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(20, 'This reset link is not valid'),
  newPassword: passwordSchema,
});

export const authUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
  status: z.string(),
  mustChangePassword: z.boolean(),
  trainerId: z.string().nullable().optional(),
  /** Projects this user leads — the scope a project_lead is confined to. */
  ledProjectIds: z.array(z.string()).default([]),
});
export type AuthUser = z.infer<typeof authUserSchema>;

export const loginResultSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number(),
  user: authUserSchema,
});
export type LoginResult = z.infer<typeof loginResultSchema>;

/**
 * How somebody is reached on their phone.
 *
 * The number and the switch travel together because they are one decision: a
 * person turning messages on generally needs to give us a number in the same
 * breath, and setting one without the other leaves them wondering which took.
 * An empty string clears the number — omitting the field leaves it alone.
 */
export const contactPreferencesSchema = z
  .object({
    phone: z.union([phoneSchema, z.literal('')]).optional(),
    mobileNotifications: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change');
export type ContactPreferencesInput = z.infer<typeof contactPreferencesSchema>;

/* -------------------------------------------------------- the second factor */

/** RFC 6238 default: six digits, rolling every thirty seconds. */
export const MFA_CODE_LENGTH = 6;
/**
 * How many windows either side of now are accepted. One covers an authenticator
 * whose clock has drifted and a person who types slowly; more than one widens
 * the guessing surface for no real gain.
 */
export const MFA_WINDOW_TOLERANCE = 1;
/** Enough to write down and keep, few enough to be worth keeping safe. */
export const MFA_RECOVERY_CODE_COUNT = 8;
/**
 * Guesses allowed against one challenge. A six-digit code has a million
 * combinations, so five is generous — but the challenge is what expires, so a
 * wrong code costs a whole sign-in rather than one of five tries at leisure.
 */
export const MFA_MAX_ATTEMPTS = 5;
/** Long enough to find a phone and read a code, short enough to be useless later. */
export const MFA_CHALLENGE_TTL_MINUTES = 10;

/**
 * Either a six-digit code from an authenticator, or one of the recovery codes.
 *
 * Taken in one field rather than two: somebody who has lost their phone should
 * not have to work out which box a recovery code goes in, and the server can
 * tell them apart by shape.
 */
export const mfaCodeSchema = z
  .string()
  .trim()
  .min(MFA_CODE_LENGTH, 'Enter the 6-digit code from your authenticator')
  .max(64)
  // Authenticator apps and password managers space codes into groups.
  .transform((value) => value.replace(/[\s-]/g, '').toUpperCase());

export const mfaVerifySchema = z.object({
  challengeToken: z.string().min(20, 'Sign in again to continue'),
  code: mfaCodeSchema,
});
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

/** Beginning enrolment part-way through a sign-in. */
export const mfaChallengeSchema = z.object({
  challengeToken: z.string().min(20, 'Sign in again to continue'),
});
export type MfaChallengeInput = z.infer<typeof mfaChallengeSchema>;

/**
 * A code and nothing else — used to turn a factor on from inside a session, and
 * to turn one off. Both need current proof of the authenticator, so both take
 * the same shape.
 */
export const mfaDisableSchema = z.object({ code: mfaCodeSchema });
export type MfaDisableInput = z.infer<typeof mfaDisableSchema>;

/** A six-digit code, or something long enough to be a recovery code. */
export function looksLikeTotpCode(code: string): boolean {
  return new RegExp(`^\\d{${MFA_CODE_LENGTH}}$`).test(code);
}
