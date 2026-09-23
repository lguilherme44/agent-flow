/**
 * A feature request's title: what a list shows for a run.
 *
 * The request itself is never shortened — it is what every stage receives. What changes is
 * what a *list* prints for it. Measured 23/09/2026: a run's line in `agent-flow feature`,
 * and its card on the Deck home, was the whole 5 KB request, markdown headings and all, so
 * the one screen meant to answer "what is running" answered with a wall of text.
 *
 * The first non-empty line, without markdown heading marks, cut at a word near `max`.
 */
export function featureTitle(request: string, max = 110): string {
  const first = request
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^\s*#+\s*/, '').trim())
    .find((line) => line !== '');
  if (first === undefined) return '';
  if (first.length <= max) return first;

  const cut = first.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
