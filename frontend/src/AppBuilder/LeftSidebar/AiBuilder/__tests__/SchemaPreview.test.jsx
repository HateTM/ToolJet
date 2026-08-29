import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { SchemaPreview } from '../SchemaPreview';

const TABLE_STEP = {
  id: 'step-1',
  type: 'CreateTable',
  description: 'tasks table',
  table: {
    table_name: 'tasks',
    columns: [
      { column_name: 'id', data_type: 'serial', is_primary_key: true, is_not_null: true, is_unique: true },
      {
        column_name: 'title',
        data_type: 'character varying',
        is_primary_key: false,
        is_not_null: true,
        is_unique: false,
      },
    ],
  },
};

describe('SchemaPreview — seed rows (ticket #48)', () => {
  it('renders the planned seed rows as a table alongside the planned table', () => {
    const steps = [
      {
        ...TABLE_STEP,
        seed_rows: [{ title: 'Buy milk' }, { title: 'Ship the app' }],
      },
    ];

    render(<SchemaPreview steps={steps} />);

    const preview = document.querySelector('[data-cy="ai-builder-schema-preview-seed-rows"]');
    expect(preview).toBeInTheDocument();
    // Every planned row's values are visible — the preview shows the data that will be inserted.
    expect(screen.getByText('Buy milk')).toBeInTheDocument();
    expect(screen.getByText('Ship the app')).toBeInTheDocument();
    expect(screen.getByText('Sample data')).toBeInTheDocument();
  });

  it('renders no seed section when the step carries no seed rows', () => {
    render(<SchemaPreview steps={[TABLE_STEP]} />);

    expect(document.querySelector('[data-cy="ai-builder-schema-preview-seed-rows"]')).toBeNull();
    // The planned table itself still renders (header summary + card name).
    expect(screen.getAllByText('tasks').length).toBeGreaterThan(0);
  });

  it('renders a blank cell for a row missing a column, and shows null as empty', () => {
    const steps = [
      {
        ...TABLE_STEP,
        seed_rows: [{ title: 'Only title', extra: null }, {}],
      },
    ];

    render(<SchemaPreview steps={steps} />);

    // extra's null value renders as an empty cell, not the string "null".
    const firstBodyRow = screen.getByText('extra').closest('thead').nextElementSibling;
    const extraCell = firstBodyRow.querySelectorAll('td')[1];
    expect(extraCell.textContent).toBe('');
  });
});
