import { z } from 'zod';

/**
 * The environment is parsed once, at boot, through a schema. A missing or
 * malformed variable fails the process immediately with a message naming the
 * variable, rather than surfacing as an undefined value hours into a request.
 */
const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  WEB_BASE_URL: z.string().url().default('http://localhost:5173'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_ACCESS_SECRET: z
    .string()
    .min(
      32,
      'JWT_ACCESS_SECRET must be at least 32 characters — generate with `openssl rand -hex 48`',
    ),
  JWT_ACCESS_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  COOKIE_SECURE: booleanish.default('false'),

  // Encrypts the TOTP secrets at rest. A secret cannot be hashed — verifying a
  // code needs it back — so this key is what stands between a database dump and
  // somebody minting codes for every privileged account.
  MFA_SECRET_KEY: z
    .string()
    .min(
      32,
      'MFA_SECRET_KEY must be at least 32 characters — generate with `openssl rand -hex 32`',
    ),

  /**
   * `required` is the posture the product ships in: a role that the permission
   * matrix says needs a second factor gets no session until it has one.
   *
   * `optional` still verifies anybody who *is* enrolled — the code path is the
   * same — but stops short of forcing enrolment. It exists for the test
   * environments, where a TOTP code is single-use within its thirty-second
   * window and a suite signing in dozens of times a minute cannot produce
   * distinct ones. The forced path is covered by its own suite, which runs
   * with this set to `required`.
   */
  MFA_ENFORCEMENT: z.enum(['required', 'optional']).default('required'),

  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('ap-south-1'),
  S3_BUCKET: z.string().default('managedops-dev'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: booleanish.default('false'),

  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_SECURE: booleanish.default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default('ManagedOps <no-reply@managedops.local>'),

  // `log` renders each message into the application log, the way Mailpit
  // catches email locally. `twilio` needs the three values below it.
  MESSAGING_PROVIDER: z.enum(['log', 'twilio']).default('log'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_SMS_FROM: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().optional(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Choosing the Twilio transport without giving it credentials would boot fine
 * and then fail on every message — the worst kind of misconfiguration, because
 * nothing is obviously broken until somebody does not get a reminder.
 */
const configuredEnvSchema = envSchema.superRefine((env, ctx) => {
  if (env.MESSAGING_PROVIDER !== 'twilio') return;
  for (const key of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_SMS_FROM'] as const) {
    if (!env[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: 'is required when MESSAGING_PROVIDER is twilio',
      });
    }
  }
});

export function loadConfiguration() {
  const parsed = configuredEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Environment is not valid:\n${problems}`);
  }
  const env = parsed.data;

  return {
    env,
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    port: env.API_PORT,
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    webBaseUrl: env.WEB_BASE_URL,
    databaseUrl: env.DATABASE_URL,
    jwt: {
      accessSecret: env.JWT_ACCESS_SECRET,
      accessTtl: env.JWT_ACCESS_TTL,
      refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    },
    cookieSecure: env.COOKIE_SECURE,
    mfa: { secretKey: env.MFA_SECRET_KEY, enforcement: env.MFA_ENFORCEMENT },
    s3: {
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    },
    mail: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      from: env.MAIL_FROM,
    },
    messaging: {
      provider: env.MESSAGING_PROVIDER,
      twilio: {
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
        smsFrom: env.TWILIO_SMS_FROM,
        whatsappFrom: env.TWILIO_WHATSAPP_FROM,
      },
    },
    logLevel: env.LOG_LEVEL,
  };
}

export type AppConfig = ReturnType<typeof loadConfiguration>;
