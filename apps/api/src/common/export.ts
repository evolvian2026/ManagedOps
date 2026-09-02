/**
 * How many rows an export returns.
 *
 * Deliberately a hard ceiling rather than "everything": an unbounded export is
 * a way to pull the whole database through one request, and at this scale a
 * thousand rows covers every real use of the button. A filtered export is the
 * answer to a bigger one, and the filters are the same as the screen's.
 */
export const EXPORT_PAGE_SIZE = 1000;
