import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingDetailModal } from './SettingDetailModal';
import type { Setting } from './types';

const put = vi.fn();
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: { ...actual.api, put: (...args: unknown[]) => put(...args) } };
});

function setting(overrides: Partial<Setting> = {}): Setting {
  return {
    key: 'approval.threshold.void',
    value: { managerAboveIdr: '200000.00' },
    description: 'Void/refund manager escalation threshold (§5.2)',
    updatedBy: null,
    updatedAt: '2026-08-20T02:00:00.000Z',
    ...overrides,
  } as Setting;
}

/**
 * The risk in replacing a JSON textarea with typed fields is that the form
 * reassembles the WRONG wire shape — and the API accepts it, so the damage only
 * surfaces later inside an approval chain or a payroll run. These tests pin the
 * shape that goes over the wire, not the layout.
 */
describe('SettingDetailModal', () => {
  beforeEach(() => {
    put.mockReset().mockResolvedValue(undefined);
  });

  it('saves a money threshold back in its object shape, as a decimal string', async () => {
    render(<SettingDetailModal setting={setting()} onClose={() => {}} onSaved={() => {}} />);

    const field = screen.getByLabelText(/Wajib disetujui Manajer di atas/);
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: '350000' } });
    fireEvent.blur(field);
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/settings/approval.threshold.void', {
        // Object, not a bare number; string, not a float (CONTRACTS §0).
        value: { managerAboveIdr: '350000.00' },
      }),
    );
  });

  it('preserves fields the registry does not expose', async () => {
    // `company.profile` carries `logoAttachmentId`, which has no editor here.
    // Saving the form must not drop it — that would be silent data loss.
    render(
      <SettingDetailModal
        setting={setting({
          key: 'company.profile',
          value: {
            name: 'Mimi Chicken',
            address: 'Jl. Sudirman 1',
            city: 'Balikpapan',
            logoAttachmentId: 'att-1',
          },
        })}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Kota/), { target: { value: 'Samarinda' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/settings/company.profile', {
        value: {
          name: 'Mimi Chicken',
          address: 'Jl. Sudirman 1',
          city: 'Samarinda',
          logoAttachmentId: 'att-1',
        },
      }),
    );
  });

  it('saves a scalar number as a number, not a string', async () => {
    render(
      <SettingDetailModal
        setting={setting({ key: 'hr.geofence_radius_m', value: 200 })}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText('Nilai'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/settings/hr.geofence_radius_m', { value: 250 }),
    );
  });

  it('explains what the setting does, in place of the developer description', () => {
    render(<SettingDetailModal setting={setting()} onClose={() => {}} onSaved={() => {}} />);
    // The help sentence, not the label that happens to share words with it.
    expect(
      screen.getByText(/Void atau refund di kasir di atas nilai ini wajib disetujui Manajer/),
    ).toBeInTheDocument();
    // The raw key stays available for support, just not as the headline.
    expect(screen.getByText('approval.threshold.void')).toBeInTheDocument();
  });

  it('refuses to edit a setting that belongs to another screen', () => {
    render(
      <SettingDetailModal
        setting={setting({ key: 'payroll.statutory', value: { enabled: false } })}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    // No save button at all: the server rejects a raw PUT here
    // (ERR_USE_WIZARD), so offering one would only teach distrust.
    expect(screen.queryByRole('button', { name: 'Simpan' })).toBeNull();
    expect(screen.getByText(/tab Payroll Statutori/)).toBeInTheDocument();
  });

  it('falls back to the raw JSON editor for an unknown key', async () => {
    render(
      <SettingDetailModal
        setting={setting({ key: 'some.future.setting', value: { a: 1 } })}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

    const raw = screen.getByLabelText(/Nilai Mentah/);
    fireEvent.change(raw, { target: { value: '{"a":2}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/settings/some.future.setting', { value: { a: 2 } }),
    );
  });

  it('rejects malformed JSON in the raw editor instead of sending it', async () => {
    render(
      <SettingDetailModal
        setting={setting({ key: 'some.future.setting', value: { a: 1 } })}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Nilai Mentah/), { target: { value: '{oops' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));

    await waitFor(() => expect(screen.getByText('JSON tidak valid')).toBeInTheDocument());
    expect(put).not.toHaveBeenCalled();
  });
});
