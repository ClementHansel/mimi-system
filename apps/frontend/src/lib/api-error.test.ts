import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { apiErrorText, apiErrorDetail, errMsg } from '@/lib/api-error';
import { translate } from '@/lib/i18n';

/**
 * The regression these tests exist for, in the owner's own screenshot
 * (2026-08-31): saving a supplier whose code was taken toasted
 *
 *     duplicate key value violates unique constraint "suppliers_code_key"
 *
 * Two halves had to change and both are asserted here: the backend stopped
 * emitting that text (`common/filters/pg-error.util.spec.ts` covers that side)
 * and the frontend stopped PRINTING `message` at all — which is the part that
 * matters even after the backend fix, because the next raw string to reach
 * `message` must not be able to reach a user either.
 *
 * So the load-bearing assertion in most of these is a NEGATIVE one: whatever
 * comes back, it is not the developer message.
 */

const RAW = 'duplicate key value violates unique constraint "suppliers_code_key"';

describe('apiErrorText — the sentence a user reads', () => {
  it('names the field and the value for a duplicate, and never echoes the driver', () => {
    const err = new ApiError(409, 'ERR_DUPLICATE', RAW, {
      entity: 'suppliers',
      field: 'code',
      value: 'SUP001',
    });
    const text = apiErrorText(err);
    expect(text).toBe('Kode "SUP001" sudah dipakai. Gunakan yang lain.');
    expect(text).not.toContain('constraint');
    expect(text).not.toContain(RAW);
  });

  it('drops the value when the server did not send one', () => {
    const err = new ApiError(409, 'ERR_DUPLICATE', RAW, { field: 'code' });
    expect(apiErrorText(err)).toBe('Kode ini sudah dipakai. Gunakan yang lain.');
  });

  it('falls back to the field-less sentence for a column no label covers', () => {
    // The whole point of `byField` being a closed list: `bank_account_name` is
    // a real column and must NOT be shown to a user as one.
    const err = new ApiError(409, 'ERR_DUPLICATE', RAW, { field: 'bank_account_name' });
    const text = apiErrorText(err);
    expect(text).toBe('Data ini sudah ada. Gunakan nilai yang berbeda.');
    expect(text).not.toContain('bank_account_name');
  });

  it('resolves a plain code with no details', () => {
    expect(apiErrorText(new ApiError(403, 'ERR_FORBIDDEN', 'Forbidden'))).toBe(
      'Anda tidak punya akses untuk tindakan ini.',
    );
  });

  it('degrades an unknown code to its HTTP status class, not to its message', () => {
    const err = new ApiError(404, 'ERR_SOMETHING_NEW', 'Widget 42 not found in table widgets');
    const text = apiErrorText(err);
    expect(text).toBe('Data yang dimaksud tidak ditemukan.');
    expect(text).not.toContain('widgets');
  });

  it('degrades an unknown 5xx code to the server sentence', () => {
    const err = new ApiError(500, 'ERR_INTERNAL', 'relation "suppliers" does not exist');
    const text = apiErrorText(err);
    expect(text).toBe('Server sedang bermasalah. Coba lagi beberapa saat.');
    expect(text).not.toContain('relation');
  });

  it('uses the caller fallback only when the status says nothing either', () => {
    // 418 is in neither the status map nor the 5xx branch — the one path a
    // screen-specific line is better than a generic one.
    const err = new ApiError(418, 'ERR_WHO_KNOWS', 'I am a teapot');
    expect(apiErrorText(err, 'Supplier gagal disimpan.')).toBe('Supplier gagal disimpan.');
    expect(apiErrorText(err)).toBe('Terjadi kesalahan. Silakan coba lagi.');
  });

  it('calls a thrown non-ApiError a connection problem', () => {
    // `fetch` rejects with a TypeError when the request never left the device.
    // Saying "data tidak valid" there sends someone to the wrong problem.
    expect(apiErrorText(new TypeError('Failed to fetch'))).toBe(
      'Tidak dapat menghubungi server. Periksa koneksi Anda.',
    );
  });

  it('never returns a raw i18n key, whatever the code is', () => {
    for (const code of ['ERR_DUPLICATE', 'ERR_NOPE', 'ERR_FORBIDDEN']) {
      for (const status of [400, 403, 404, 409, 422, 500, 418]) {
        const text = apiErrorText(new ApiError(status, code, 'dev text'));
        expect(text).not.toMatch(/^errors\./);
        expect(text).not.toBe('dev text');
      }
    }
  });
});

describe('apiErrorDetail — the second line under an explicit title', () => {
  it('adds the specific sentence when there is one', () => {
    const err = new ApiError(409, 'ERR_DUPLICATE', RAW, { field: 'code', value: 'SUP001' });
    expect(apiErrorDetail(err)).toBe('Kode "SUP001" sudah dipakai. Gunakan yang lain.');
  });

  it('adds nothing when all it could say is "an error occurred"', () => {
    // "Terjadi kesalahan" under "Penjualan gagal" is two lines saying one thing.
    expect(apiErrorDetail(new ApiError(418, 'ERR_WHO_KNOWS', 'I am a teapot'))).toBeUndefined();
  });
});

describe('errMsg — the signature the 28 panel-local copies used', () => {
  it('is apiErrorText with the fallback threaded through', () => {
    const err = new ApiError(409, 'ERR_DUPLICATE', RAW, { field: 'code' });
    expect(errMsg(err, 'x')).toBe(apiErrorText(err, 'x'));
    expect(errMsg(new ApiError(418, 'ERR_X', 'y'), 'Gagal memuat')).toBe('Gagal memuat');
  });
});

describe('the dictionary backing all of the above', () => {
  it('has every key this module can reach', () => {
    // `translate` returns THE KEY on a miss, so a typo here ships the key to a
    // toast. `lookup()` guards against that at runtime; this catches it in CI.
    for (const key of [
      'errors.generic',
      'errors.network',
      'errors.badRequest',
      'errors.unauthorized',
      'errors.forbidden',
      'errors.notFound',
      'errors.conflict',
      'errors.server',
      'errors.byCode.ERR_DUPLICATE',
      'errors.byCode.ERR_DUPLICATE_FIELD',
      'errors.byCode.ERR_DUPLICATE_FIELD_NO_VALUE',
      'errors.byCode.ERR_VALIDATION_FIELD',
      'errors.byField.code',
    ]) {
      expect(translate(key)).not.toBe(key);
    }
  });
});
