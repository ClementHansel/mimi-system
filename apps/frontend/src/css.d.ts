// Next's own ambient types (next-env.d.ts → next/types/global.d.ts) only
// declare `*.module.css` (CSS Modules). `globals.css` is a plain side-effect
// stylesheet import in `app/layout.tsx` — Next's webpack/SWC pipeline handles
// that natively at build time, but a standalone `tsc --noEmit` needs this
// shim or it reports "cannot find module" on the import.
declare module '*.css';
