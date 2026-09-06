export function slugify(text: string, max = 60): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/-+$/g, '');
}
