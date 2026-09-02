import { v7 as uuidv7 } from 'uuid';

/**
 * UUID v7: random enough to expose in a URL, but time-ordered, so inserts stay
 * on the right-hand side of the B-tree and `ORDER BY id` matches creation order.
 */
export function newId(): string {
  return uuidv7();
}
