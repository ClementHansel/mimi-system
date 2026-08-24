import { getAccessToken } from '@/stores/session-store';
import { API_BASE_URL, ApiError } from '@/lib/api';
import type { ImportEntityName } from '../types';

/**
 * Downloads `GET /api/import/:entity/template` and saves it as a file.
 *
 * NOT `apiFetch`/`api.get`: that client unconditionally calls `res.json()`
 * (see `lib/api.ts`) — fine for every other endpoint in the app, wrong here
 * because this response body IS the file, a CSV, not a JSON envelope around
 * one. Same reasoning `product-photo-cache.ts`'s `fetchPhotoBlob` already
 * uses for a different non-JSON response (a photo): a plain authenticated
 * `fetch` + `Blob`.
 */
export async function downloadImportTemplate(entity: ImportEntityName): Promise<void> {
  const token = getAccessToken();
  const res = await fetch(`${API_BASE_URL}/import/${entity}/template`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(
      res.status,
      typeof body?.code === 'string' ? body.code : 'ERR_UNKNOWN',
      typeof body?.message === 'string' ? body.message : `Gagal mengambil template (${res.status})`,
    );
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${entity}_template.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
