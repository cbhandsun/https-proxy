// Small ESM helper used by src/main.js. Demonstrates a clean import/export
// module so the Vite pipeline has at least one real ESM file to bundle.

export function greet(name) {
  return `hello from Vite, ${name}`;
}

export function formatTimestamp(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().replace('T', ' ').replace(/\..+$/, '');
}
