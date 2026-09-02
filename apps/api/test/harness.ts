import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { PasswordService } from '../src/modules/identity/password.service.js';
import { newId } from '../src/common/ids.js';
import type { Role } from '@managedops/shared';

/**
 * Boots the real application against a real PostgreSQL database.
 *
 * These are not unit tests with a mocked repository: the whole point is to
 * exercise the guards, the validation pipe, the Problem Details filter and the
 * database constraints together, because that is where the behaviour actually
 * lives.
 */
export interface Harness {
  app: INestApplication;
  prisma: PrismaService;
  http: () => request.Agent;
  close: () => Promise<void>;
  seedUser: (options: SeedUserOptions) => Promise<SeededUser>;
  signIn: (email: string, password?: string) => Promise<Session>;
  /** Gives an account a known password, e.g. one created by offer conversion. */
  setPassword: (userId: string, password?: string) => Promise<void>;
}

export interface SeedUserOptions {
  role: Role;
  email?: string;
  name?: string;
  password?: string;
  mustChangePassword?: boolean;
  status?: 'active' | 'disabled';
}

export interface SeededUser {
  id: string;
  email: string;
  password: string;
  role: Role;
}

export interface Session {
  accessToken: string;
  refreshCookie: string;
  csrfToken: string;
  user: { id: string; role: Role; mustChangePassword: boolean };
}

export const TEST_PASSWORD = 'TestPassw0rd!2026';

export async function createHarness(): Promise<Harness> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();

  const prisma = app.get(PrismaService);
  const passwords = app.get(PasswordService);
  const http = () => request.agent(app.getHttpServer());

  let sequence = 0;

  return {
    app,
    prisma,
    http,
    close: async () => {
      await app.close();
    },

    async seedUser(options: SeedUserOptions): Promise<SeededUser> {
      sequence += 1;
      const password = options.password ?? TEST_PASSWORD;
      const email = options.email ?? `${options.role}.${sequence}.${Date.now()}@test.local`;
      const user = await prisma.db.user.create({
        data: {
          id: newId(),
          name: options.name ?? `Test ${options.role}`,
          email,
          role: options.role,
          status: options.status ?? 'active',
          passwordHash: await passwords.hash(password),
          mustChangePassword: options.mustChangePassword ?? false,
        },
      });
      return { id: user.id, email: user.email, password, role: user.role };
    },

    async setPassword(userId: string, password = TEST_PASSWORD): Promise<void> {
      await prisma.db.user.update({
        where: { id: userId },
        data: {
          passwordHash: await passwords.hash(password),
          mustChangePassword: false,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
    },

    async signIn(email: string, password = TEST_PASSWORD): Promise<Session> {
      const response = await http()
        .post('/api/v1/auth/login')
        .send({ email, password })
        .expect(200);

      const cookies = (response.headers['set-cookie'] as unknown as string[]) ?? [];
      const refreshCookie = cookies.find((c) => c.startsWith('managedops_refresh=')) ?? '';
      const csrfCookie = cookies.find((c) => c.startsWith('managedops_csrf=')) ?? '';

      return {
        accessToken: response.body.accessToken,
        refreshCookie: refreshCookie.split(';')[0] ?? '',
        csrfToken: (csrfCookie.split(';')[0] ?? '').split('=')[1] ?? '',
        user: response.body.user,
      };
    },
  };
}

/** Wipes every table so each test file starts from a known state. */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await prisma.truncateAll();
}

/**
 * Polls until `check` returns something truthy.
 *
 * The audit interceptor writes after the response is sent, so the request never
 * waits on it. Tests therefore have to wait for the write — and polling for the
 * row is stable, whereas a fixed sleep is a race that passes on a fast machine
 * and fails on a loaded one.
 */
export async function eventually<T>(
  check: () => Promise<T | null | undefined | false>,
  { timeoutMs = 5000, intervalMs = 25 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;

  while (Date.now() < deadline) {
    last = await check();
    if (last) return last as T;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition was still not met after ${timeoutMs}ms`);
}
