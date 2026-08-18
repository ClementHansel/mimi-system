import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DataTable, type DataTableColumn } from './DataTable';
import type { Paginated } from '@/lib/api';

interface Row {
  id: string;
  name: string;
  qty: number;
}

const columns: DataTableColumn<Row>[] = [
  { key: 'name', header: 'Nama', sortable: true },
  { key: 'qty', header: 'Qty', align: 'right' },
];

function paginated(rows: Row[], overrides: Partial<Paginated<Row>> = {}): Paginated<Row> {
  return { rows, total: rows.length, page: 1, pageSize: 50, ...overrides };
}

describe('DataTable', () => {
  it('renders rows and cell values', () => {
    const data = paginated([
      { id: '1', name: 'Ayam Goreng', qty: 12 },
      { id: '2', name: 'Kentang Goreng', qty: 5 },
    ]);
    render(<DataTable columns={columns} data={data} keyField={(r) => r.id} />);
    expect(screen.getByText('Ayam Goreng')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('Kentang Goreng')).toBeInTheDocument();
  });

  it('shows the empty state when there are no rows', () => {
    render(<DataTable columns={columns} data={paginated([])} keyField={(r) => r.id} />);
    expect(screen.getByText('Belum ada data')).toBeInTheDocument();
  });

  it('shows a custom empty title/description when provided', () => {
    render(
      <DataTable
        columns={columns}
        data={paginated([])}
        keyField={(r) => r.id}
        emptyTitle="Belum ada produk"
        emptyDescription="Tambahkan produk pertama Anda."
      />,
    );
    expect(screen.getByText('Belum ada produk')).toBeInTheDocument();
    expect(screen.getByText('Tambahkan produk pertama Anda.')).toBeInTheDocument();
  });

  it('shows skeleton rows while loading, not the data or empty state', () => {
    const { container } = render(
      <DataTable
        columns={columns}
        data={paginated([{ id: '1', name: 'X', qty: 1 }])}
        keyField={(r) => r.id}
        loading
      />,
    );
    expect(screen.queryByText('X')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('shows the error state instead of rows', () => {
    render(
      <DataTable
        columns={columns}
        data={paginated([{ id: '1', name: 'X', qty: 1 }])}
        keyField={(r) => r.id}
        error="Gagal memuat data stok"
      />,
    );
    expect(screen.getByText('Gagal memuat data stok')).toBeInTheDocument();
    expect(screen.queryByText('X')).not.toBeInTheDocument();
  });

  it('calls onSortChange with the column key when a sortable header is clicked', () => {
    const onSortChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={paginated([{ id: '1', name: 'X', qty: 1 }])}
        keyField={(r) => r.id}
        onSortChange={onSortChange}
      />,
    );
    screen.getByRole('button', { name: /Nama/ }).click();
    expect(onSortChange).toHaveBeenCalledWith('name');
  });

  it('paginates: shows page info and disables Next on the last page', () => {
    const data = paginated([{ id: '1', name: 'X', qty: 1 }], { total: 120, page: 3, pageSize: 50 });
    render(
      <DataTable columns={columns} data={data} keyField={(r) => r.id} onPageChange={() => {}} />,
    );
    expect(screen.getByText('Halaman 3 dari 3')).toBeInTheDocument();
    expect(screen.getByLabelText('Lanjut')).toBeDisabled();
    expect(screen.getByLabelText('Kembali')).not.toBeDisabled();
  });

  it('calls onPageChange with the next page number', () => {
    const onPageChange = vi.fn();
    const data = paginated([{ id: '1', name: 'X', qty: 1 }], { total: 120, page: 1, pageSize: 50 });
    render(
      <DataTable
        columns={columns}
        data={data}
        keyField={(r) => r.id}
        onPageChange={onPageChange}
      />,
    );
    screen.getByLabelText('Lanjut').click();
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('calls onRowClick with the clicked row', () => {
    const onRowClick = vi.fn();
    const row = { id: '1', name: 'Ayam Goreng', qty: 12 };
    render(
      <DataTable
        columns={columns}
        data={paginated([row])}
        keyField={(r) => r.id}
        onRowClick={onRowClick}
      />,
    );
    screen
      .getByText('Ayam Goreng')
      .closest('tr')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onRowClick).toHaveBeenCalledWith(row);
  });
});
