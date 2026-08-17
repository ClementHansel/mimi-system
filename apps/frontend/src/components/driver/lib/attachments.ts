/**
 * `SignaturePad`'s canvas data URL → `File`, for `captureEvidence`. Same
 * small helper `components/outlet/lib/attachments.ts` defines — kept as its
 * own copy here rather than a cross-surface import so `components/driver`
 * stays self-contained (every Wave 4 surface owns its own thin lib, per the
 * pattern `outlet`/`pos` already established).
 */
export function dataUrlToFile(dataUrl: string, fileName = 'signature.png'): File {
  const [header, base64] = dataUrl.split(',');
  const mime = /data:(.*?);base64/.exec(header ?? '')?.[1] ?? 'image/png';
  const binary = atob(base64 ?? '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], fileName, { type: mime });
}
