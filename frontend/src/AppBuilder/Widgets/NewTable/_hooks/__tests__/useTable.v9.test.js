import '@testing-library/jest-dom';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { useTable } from '../useTable';

// Smoke test for the TanStack Table v9 wiring: feature registration,
// controlled state slices and instance APIs used by the NewTable widget.

const data = [
  { id: 1, name: 'alpha', score: 3 },
  { id: 2, name: 'beta', score: 1 },
  { id: 3, name: 'gamma', score: 2 },
];

const columns = [
  { id: 'id', accessorKey: 'id', header: 'ID' },
  { id: 'name', accessorKey: 'name', header: 'Name' },
  { id: 'score', accessorKey: 'score', header: 'Score' },
];

const renderDataTable = () =>
  renderHook((props) => useTable(props), {
    initialProps: {
      data,
      columns,
      enableSorting: true,
      enablePagination: false,
      showBulkSelector: false,
      serverSidePagination: false,
      serverSideSort: false,
      serverSideFilter: false,
      rowsPerPage: 2,
      globalFilter: '',
      setGlobalFilter: jest.fn(),
    },
  });

describe('NewTable useTable (TanStack v9)', () => {
  it('builds a table with all rows via the core row model', () => {
    const { result } = renderDataTable();
    expect(result.current.table.getRowModel().rows).toHaveLength(3);
  });

  it('exposes state slices on table.state', () => {
    const { result } = renderDataTable();
    expect(result.current.table.state).toMatchObject({
      globalFilter: '',
      columnFilters: [],
    });
  });

  it('sorts rows programmatically via setSorting', () => {
    const { result } = renderDataTable();
    const { table } = result.current;
    act(() => {
      table.setSorting([{ id: 'score', desc: true }]);
    });
    const rows = table.getSortedRowModel().rows;
    expect(rows[0].original.score).toBe(3);
    expect(rows[2].original.score).toBe(1);
  });

  it('paginates rows with the paginated row model feature', () => {
    const props = {
      data,
      columns,
      enableSorting: true,
      enablePagination: true,
      showBulkSelector: false,
      serverSidePagination: false,
      serverSideSort: false,
      serverSideFilter: false,
      rowsPerPage: 2,
      globalFilter: '',
      setGlobalFilter: jest.fn(),
    };
    const { result, rerender } = renderHook((p) => useTable(p), { initialProps: props });
    const { table } = result.current;
    expect(table.getPaginatedRowModel().rows).toHaveLength(2);
    act(() => {
      table.setPageIndex(1);
    });
    rerender(props);
    expect(table.getPaginatedRowModel().rows).toHaveLength(1);
  });

  it('selects and resets rows through the row selection feature', () => {
    const { result } = renderDataTable();
    const { table } = result.current;
    act(() => {
      table.setRowSelection({ 0: true, 2: true });
    });
    expect(table.getFilteredSelectedRowModel().rows).toHaveLength(2);
    act(() => {
      table.resetRowSelection();
    });
    expect(table.getFilteredSelectedRowModel().rows).toHaveLength(0);
  });
});
