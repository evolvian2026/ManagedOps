import { z } from 'zod';
import { ROLES } from '../enums.js';
import { emailSchema } from './common.js';

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
