// v9 uses logical pinning regions (start/end); ToolJet's widget DSL and the
// sticky CSS inset it feeds keep the physical left/right naming.
const logicalToPhysical = { start: 'left', end: 'right' };

export const getPinnedPosition = (column) => {
  const pinnedPosition = logicalToPhysical[column.getIsPinned?.()];
  if (pinnedPosition) {
    return pinnedPosition;
  }

  const configuredPosition = column.columnDef?.meta?.pinPosition;
  if (configuredPosition === 'left' || configuredPosition === 'right') {
    return configuredPosition;
  }

  return false;
};

const getPinnedLeafColumns = (table, position) => {
  if (!table) return [];
  return position === 'left' ? (table.getStartLeafColumns?.() ?? []) : (table.getEndLeafColumns?.() ?? []);
};

const getPinnedOffsetFallback = (column, table, position) => {
  const pinnedLeafColumns = getPinnedLeafColumns(table, position);
  const pinnedColumnIndex = pinnedLeafColumns.findIndex((leafColumn) => leafColumn.id === column.id);

  if (pinnedColumnIndex < 0) return 0;

  if (position === 'left') {
    return pinnedLeafColumns
      .slice(0, pinnedColumnIndex)
      .reduce((offset, leafColumn) => offset + leafColumn.getSize(), 0);
  }

  return pinnedLeafColumns
    .slice(pinnedColumnIndex + 1)
    .reduce((offset, leafColumn) => offset + leafColumn.getSize(), 0);
};

export const getPinnedOffset = (column, table, position) => {
  if (position === 'left' && typeof column.getStart === 'function') {
    return column.getStart('start');
  }

  if (position === 'right' && typeof column.getAfter === 'function') {
    return column.getAfter('end');
  }

  return getPinnedOffsetFallback(column, table, position);
};

export const getPinnedBoundaryState = (column, table, position) => {
  if (position === 'left') {
    if (typeof column.getIsLastColumn === 'function') {
      return column.getIsLastColumn('start');
    }

    const leftColumns = getPinnedLeafColumns(table, 'left');
    return leftColumns[leftColumns.length - 1]?.id === column.id;
  }

  if (typeof column.getIsFirstColumn === 'function') {
    return column.getIsFirstColumn('end');
  }

  const rightColumns = getPinnedLeafColumns(table, 'right');
  return rightColumns[0]?.id === column.id;
};

export const getPinnedStyles = ({ column, table, isHeader = false }) => {
  const pinnedPosition = getPinnedPosition(column);

  if (!pinnedPosition) {
    return {
      pinnedPosition: false,
      isPinnedBoundary: false,
      style: {},
    };
  }

  return {
    pinnedPosition,
    isPinnedBoundary: getPinnedBoundaryState(column, table, pinnedPosition),
    style: {
      position: 'sticky',
      [pinnedPosition]: `${getPinnedOffset(column, table, pinnedPosition)}px`,
      zIndex: isHeader ? 3 : 2,
    },
  };
};
