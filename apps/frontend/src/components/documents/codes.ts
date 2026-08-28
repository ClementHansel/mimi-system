/**
 * The `code` element's symbol: what a QR / barcode box on a template actually
 * draws, as an SVG STRING.
 *
 * WHY A STRING AND NOT JSX. This module has two consumers that cannot share a
 * React tree: `DocumentRenderer`'s on-screen preview (React) and
 * `buildDocHtml`, which serialises a whole document into the HTML of a
 * detached print window (a plain string, no React runtime, no hydration).
 * Producing SVG markup once and letting the React side inject it via
 * `dangerouslySetInnerHTML` keeps ONE implementation of the symbol geometry —
 * the alternative, a component plus a string builder, is the exact
 * two-copies-that-drift shape `documents/template.ts`'s header was written to
 * prevent. The markup is generated entirely from numbers we compute here, and
 * the only interpolated text (`escapeXmlText`) is escaped, so injecting it is
 * safe by construction rather than by trust.
 *
 * ── QR: REAL, and not hand-rolled ────────────────────────────────────────────
 * `qrcode@1.5.4` is ALREADY a declared dependency of this app (package.json,
 * alongside `@types/qrcode`) — so using it adds nothing to the bundle budget
 * and violates no "no new runtime dependency" rule. Critically we use its
 * `create()`, which is SYNCHRONOUS and returns the raw module matrix; every
 * other entry point in that package (`toDataURL`, `toString`, `toCanvas`) is
 * promise-based or needs a DOM canvas, and neither is available inside
 * `buildDocHtml`, which must return finished HTML from a pure call. We render
 * the matrix to SVG ourselves, which is ~20 lines and fully verifiable.
 *
 * Rejected: hand-rolling a QR encoder. Reed-Solomon + mask selection + version
 * planning is several hundred lines whose failure mode is a symbol that LOOKS
 * right and scans as garbage, and there was a correct encoder already in the
 * dependency list.
 *
 * ── BARCODE: deliberately NOT a scannable symbol, and why ────────────────────
 * A `codeType: 'barcode'` element renders the payload as a high-contrast
 * monospace block in a ruled box — human-readable and hand-keyable, NOT
 * machine-scannable.
 *
 * The honest reason: Code 128 is a 107-entry LOOKUP TABLE, not an algorithm.
 * It cannot be derived, only transcribed, and a single transposed digit — or a
 * mis-assigned START/STOP row — produces bars that print beautifully and scan
 * as nothing, or worse, as a different string. There is no maintained Code 128
 * encoder in this repo's dependency tree to cross-check a transcription
 * against, and no offline way to validate one, so shipping a table reproduced
 * from memory would be shipping a symbol nobody could trust on a legal
 * shipping document. The brief's own instruction for exactly this situation is
 * to say so and degrade gracefully rather than ship a broken symbol.
 *
 * What this costs: nothing today. None of the four seeded default templates
 * uses `codeType: 'barcode'` (`documents/defaults.ts` — the voucher card is
 * the only one with a `code` element at all, and it is `qr`), so a barcode is
 * an owner opt-in. What it would cost tomorrow: if warehouse scanning of a
 * printed Surat Jalan is ever required, the fix is to add a MAINTAINED encoder
 * (`jsbarcode`/`bwip-js`) and swap `renderBarcodeSvg`'s body — the element
 * type, the template model, the designer and the print routes all stay
 * exactly as they are. That is flagged, not hidden.
 */

import { create as createQrMatrix } from 'qrcode';

/**
 * Escapes text destined for an XML/HTML text node or a double-quoted
 * attribute. `&` must be replaced first or it would double-escape the
 * entities the later replacements introduce.
 */
export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Quiet zone, in modules, on all four sides. The QR spec requires 4; smaller
 * values are common in web widgets (where a phone camera is 5cm away and
 * forgiving) and are wrong on paper, where the symbol may sit next to a table
 * rule that a scanner reads as part of the finder pattern.
 */
const QR_QUIET_ZONE = 4;

/**
 * QR error-correction level. 'M' (~15% recovery) is the right trade for a
 * voucher card that lives in a wallet and a delivery note that rides in a van:
 * 'L' fails on a creased card, and 'H' inflates the module count enough that
 * an 80×80px box at 96dpi drops below the module size a phone can resolve.
 */
const QR_ERROR_CORRECTION = 'M' as const;

/**
 * A real QR symbol as `<svg>` markup, sized to fill `size` CSS px.
 *
 * The dark modules are emitted as ONE `<path>` built from horizontal runs
 * rather than one `<rect>` per module: a version-5 symbol is 37×37 = up to
 * ~700 dark modules, and 700 rects is both a large HTML string to ship into a
 * print window and a measurable layout cost when the designer re-renders the
 * preview on every drag frame.
 *
 * Returns `null` when the payload is empty or the encoder refuses it (a
 * payload longer than the largest version can hold). A null return is the
 * caller's cue to draw the box's fallback — never a thrown error, because this
 * runs inside a print path where an exception means a blank page instead of a
 * document with one missing square.
 */
export function renderQrSvg(payload: string, size: number, color: string): string | null {
  if (!payload) return null;

  let matrix: { size: number; data: { [index: number]: number } };
  try {
    matrix = createQrMatrix(payload, { errorCorrectionLevel: QR_ERROR_CORRECTION }).modules;
  } catch {
    return null;
  }

  const modules = matrix.size;
  const extent = modules + QR_QUIET_ZONE * 2;
  const segments: string[] = [];

  for (let row = 0; row < modules; row++) {
    let runStart = -1;
    // `<= modules` so the loop's final iteration closes a run that reaches the
    // right edge, without duplicating the flush logic after the loop.
    for (let col = 0; col <= modules; col++) {
      const dark = col < modules && !!matrix.data[row * modules + col];
      if (dark && runStart === -1) runStart = col;
      if (!dark && runStart !== -1) {
        const x = runStart + QR_QUIET_ZONE;
        const y = row + QR_QUIET_ZONE;
        segments.push(`M${x} ${y}h${col - runStart}v1h-${col - runStart}z`);
        runStart = -1;
      }
    }
  }

  // `shape-rendering:crispEdges` stops the browser antialiasing module edges
  // into grey on screen; on paper it is the difference between a scanner
  // seeing a clean 1-bit grid and seeing a soft one at small module sizes.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${extent} ${extent}" shape-rendering="crispEdges" role="img">` +
    `<rect width="${extent}" height="${extent}" fill="#ffffff"/>` +
    `<path d="${segments.join('')}" fill="${escapeXmlText(color)}"/>` +
    `</svg>`
  );
}

/**
 * The barcode element's honest stand-in: the payload set in a ruled box, in a
 * monospace face with wide letter-spacing so a human can read a long code back
 * over a counter without losing their place. See this file's header for why
 * this is not a Code 128 symbol.
 *
 * Rendered as SVG rather than HTML so it composes identically with the QR
 * branch in both consumers and so the text scales with the box the owner drew,
 * instead of overflowing it at a font size the designer never chose.
 */
export function renderBarcodeSvg(
  payload: string,
  width: number,
  height: number,
  color: string,
): string | null {
  if (!payload) return null;

  const text = escapeXmlText(payload);
  // Fit the payload to the box: the widest glyph advance in a monospace face
  // is ~0.62em, and we add the letter-spacing back in, so `chars * 0.72em`
  // approximates the run's width. Capped at 60% of the box height so a short
  // code in a tall box does not print as a poster.
  const perChar = 0.72;
  const fitted = width / Math.max(1, payload.length * perChar);
  const fontSize = Math.max(6, Math.min(fitted, height * 0.6));

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" role="img">` +
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="#ffffff" ` +
    `stroke="${escapeXmlText(color)}" stroke-width="1"/>` +
    `<text x="${width / 2}" y="${height / 2}" fill="${escapeXmlText(color)}" ` +
    `font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" ` +
    `font-size="${fontSize.toFixed(2)}" font-weight="700" letter-spacing="${(fontSize * 0.1).toFixed(2)}" ` +
    `text-anchor="middle" dominant-baseline="central">${text}</text>` +
    `</svg>`
  );
}

/**
 * The one entry point the renderer calls. `codeType` defaults to `'qr'` to
 * match `DocElement.codeType`'s optionality — an element saved before the
 * property existed, or by an owner who never opened the dropdown, draws the
 * symbology the seeded templates use.
 */
export function renderCodeSvg(
  codeType: 'qr' | 'barcode' | undefined,
  payload: string,
  width: number,
  height: number,
  color: string,
): string | null {
  if (codeType === 'barcode') return renderBarcodeSvg(payload, width, height, color);
  // A QR is square; a non-square box gets the largest square that fits, which
  // the caller centres. Distorting a QR to fill a rectangle makes it unreadable.
  return renderQrSvg(payload, Math.min(width, height), color);
}
