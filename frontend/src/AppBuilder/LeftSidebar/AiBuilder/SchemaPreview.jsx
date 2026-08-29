import React from 'react';

const ColumnFlags = ({ column }) => {
  const flags = [
    column.is_primary_key && 'PK',
    column.is_unique && !column.is_primary_key && 'unique',
    column.is_not_null && 'required',
  ].filter(Boolean);
  if (!flags.length) return null;
  return (
    <span className="tw-flex tw-gap-1">
      {flags.map((flag) => (
        <span
          key={flag}
          className="tw-rounded tw-border tw-border-solid tw-border-border-weak tw-bg-background-surface-layer-02 tw-px-1 tw-text-[10px] tw-leading-4 tw-text-text-placeholder"
        >
          {flag}
        </span>
      ))}
    </span>
  );
};

const ForeignKeyLine = ({ foreignKeys }) => (
  <div className="tw-text-xs tw-text-text-placeholder" data-cy="ai-builder-schema-preview-foreign-keys">
    {foreignKeys
      .map(
        (foreignKey) =>
          `${foreignKey.column_names.join(', ')} → ${
            foreignKey.referenced_table_name
          }.${foreignKey.referenced_column_names.join(', ')}`
      )
      .join('; ')}
  </div>
);

const TableCard = ({ step }) => {
  const table = step.table;
  return (
    <div
      className="tw-flex tw-flex-col tw-gap-1.5 tw-rounded-lg tw-border tw-border-solid tw-border-border-weak tw-bg-background-surface-layer-02 tw-p-2.5"
      data-cy="ai-builder-schema-preview-table"
    >
      <div className="tw-flex tw-items-center tw-gap-2">
        <span className="tw-text-xs tw-font-medium tw-text-text-accent">Table</span>
        <span className="tw-text-sm tw-font-medium tw-text-text-default">{table.table_name}</span>
      </div>
      <div className="tw-flex tw-flex-col tw-gap-0.5">
        {(table.columns || []).map((column) => (
          <div key={column.column_name} className="tw-flex tw-items-center tw-justify-between tw-gap-2">
            <span className="tw-text-xs tw-text-text-default">{column.column_name}</span>
            <span className="tw-flex tw-items-center tw-gap-1.5">
              <span className="tw-text-xs tw-text-text-placeholder">{column.data_type}</span>
              <ColumnFlags column={column} />
            </span>
          </div>
        ))}
      </div>
      {table.foreign_keys?.length > 0 && <ForeignKeyLine foreignKeys={table.foreign_keys} />}
    </div>
  );
};

const StepLine = ({ step }) => (
  <div
    className="tw-flex tw-items-start tw-gap-1.5 tw-text-xs tw-text-text-default"
    data-cy="ai-builder-schema-preview-step"
  >
    <span className="tw-text-text-placeholder">•</span>
    <span>{step.description}</span>
  </div>
);

/**
 * The pre-approval schema preview (ticket #20): renders the previewed plan's structure —
 * each CreateTable step's concrete planned table (the same definition executeCreateTableStep
 * creates verbatim on approval), and every other step as a plain line item.
 */
export const SchemaPreview = ({ steps, title = 'Build plan preview' }) => {
  const tableSteps = steps.filter((step) => step.table);
  const otherSteps = steps.filter((step) => !step.table);
  return (
    <div
      className="tw-flex tw-flex-col tw-gap-2 tw-rounded-lg tw-border tw-border-solid tw-border-border-weak tw-bg-background-surface-layer-01 tw-p-2.5"
      data-cy="ai-builder-schema-preview"
    >
      <div className="tw-text-xs tw-font-medium tw-text-text-default">
        {title}
        {tableSteps.length > 0 && (
          <span className="tw-ml-1.5 tw-text-text-placeholder">
            {tableSteps.map((step) => step.table.table_name).join(', ')}
          </span>
        )}
      </div>
      {tableSteps.map((step) => (
        <TableCard key={step.id} step={step} />
      ))}
      {otherSteps.map((step) => (
        <StepLine key={step.id} step={step} />
      ))}
    </div>
  );
};

export default SchemaPreview;
