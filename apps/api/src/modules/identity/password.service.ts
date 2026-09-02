import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Argon2id at OWASP's recommended second-choice parameters (19 MiB, t=2, p=1).
 * Memory hardness is what makes a stolen hash expensive to attack on GPUs,
 * which is why this is preferred over bcrypt.
 */
const ARGON_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

// Ambiguous glyphs are excluded so a password read off an email is typed right.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return argon2.hash(plain, ARGON_OPTIONS);
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      // A malformed stored hash must read as "wrong password", never as a crash.
      return false;
    }
  }

  /**
   * A temporary password for a newly created account. Always contains an
   * uppercase letter, a lowercase letter and a digit so it satisfies the same
   * policy the user will be held to when they change it.
   */
  generateTemporary(length = 16): string {
    const required = [
      pick('ABCDEFGHJKLMNPQRSTUVWXYZ'),
      pick('abcdefghijkmnopqrstuvwxyz'),
      pick('23456789'),
    ];
    const rest = Array.from({ length: Math.max(0, length - required.length) }, () =>
      pick(ALPHABET),
    );
    return shuffle([...required, ...rest]).join('');
  }
}

function pick(source: string): string {
  return source[randomInt(source.length)] as string;
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [items[i], items[j]] = [items[j] as T, items[i] as T];
  }
  return items;
}
