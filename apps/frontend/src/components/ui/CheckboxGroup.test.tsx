import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CheckboxGroup } from './CheckboxGroup';

/**
 * SELECT-ALL, AND THE ONE THING IT MUST NOT DO.
 *
 * MA-193: "Tambahkan Check All untuk form - form yang memiliki multiple
 * Checkbox." The case that prompted it is user location assignment — 22
 * branches on production, rendered as 22 individual checkboxes, twice over
 * (the create modal and the drawer carried the same block character for
 * character), so putting a Manager on the whole company was 22 clicks in two
 * places.
 *
 * The interesting assertion here is not that "check all" checks things. It is
 * that it CANNOT REACH A DISABLED OPTION. A disabled checkbox is disabled for a
 * reason the group knows nothing about, and a bulk control that ignored that
 * would be a way to set exactly what the individual control refuses — a
 * quieter and worse bug than the 22 clicks it replaces.
 */
const OPTIONS = [
  { value: 'a', label: 'Outlet A' },
  { value: 'b', label: 'Outlet B' },
  { value: 'c', label: 'Outlet C' },
];

function renderGroup(props: Partial<Parameters<typeof CheckboxGroup>[0]> = {}) {
  const onChange = vi.fn();
  render(<CheckboxGroup options={OPTIONS} value={[]} onChange={onChange} {...props} />);
  return onChange;
}

describe('CheckboxGroup', () => {
  it('selects every option in one click, and reports the running count', () => {
    const onChange = renderGroup({ value: ['a'] });

    expect(screen.getByText('1 dari 3 dipilih')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Pilih Semua'));
    expect(onChange).toHaveBeenCalledWith(['a', 'b', 'c']);
  });

  it('clears everything when all are already selected', () => {
    const onChange = renderGroup({ value: ['a', 'b', 'c'] });

    // Already all-checked, so the same control is the way back out.
    expect(screen.getByLabelText('Pilih Semua')).toBeChecked();
    fireEvent.click(screen.getByLabelText('Pilih Semua'));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('will not select a DISABLED option, and will not clear one either', () => {
    const options = [...OPTIONS, { value: 'locked', label: 'Outlet Terkunci', disabled: true }];

    // Nothing selected: select-all takes the three selectable ones only.
    const onSelect = vi.fn();
    const { unmount } = render(<CheckboxGroup options={options} value={[]} onChange={onSelect} />);
    fireEvent.click(screen.getByLabelText('Pilih Semua'));
    expect(
      onSelect.mock.calls[0]![0],
      'select-all reached past a gate the individual control enforces',
    ).toEqual(['a', 'b', 'c']);
    unmount();

    // A disabled option that was ALREADY selected survives a clear-all — the
    // group did not put it there and has no business removing it.
    const onClear = vi.fn();
    render(
      <CheckboxGroup options={options} value={['a', 'b', 'c', 'locked']} onChange={onClear} />,
    );
    fireEvent.click(screen.getByLabelText('Pilih Semua'));
    expect(onClear.mock.calls[0]![0]).toEqual(['locked']);
  });

  it('reads as all-selected when only the disabled option is left out', () => {
    // Otherwise the control could never look satisfied, and a user would keep
    // clicking a checkbox that appears to do nothing.
    renderGroup({
      options: [...OPTIONS, { value: 'locked', label: 'Outlet Terkunci', disabled: true }],
      value: ['a', 'b', 'c'],
    });
    expect(screen.getByLabelText('Pilih Semua')).toBeChecked();
  });

  it('leaves out the select-all row when there is nothing to bulk-select', () => {
    renderGroup({ options: [OPTIONS[0]!] });

    // One checkbox needs no "check all" above it — that is noise, not help.
    expect(screen.queryByLabelText('Pilih Semua')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Outlet A')).toBeInTheDocument();
  });

  it('toggles a single option without disturbing the others', () => {
    const onChange = renderGroup({ value: ['a'] });

    fireEvent.click(screen.getByLabelText('Outlet B'));
    expect(onChange).toHaveBeenCalledWith(['a', 'b']);

    fireEvent.click(screen.getByLabelText('Outlet A'));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('disables the whole group, select-all included', () => {
    renderGroup({ disabled: true });

    expect(screen.getByLabelText('Pilih Semua')).toBeDisabled();
    expect(screen.getByLabelText('Outlet A')).toBeDisabled();
  });
});
