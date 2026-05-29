// Generic Pass B regression fixture — non-ECHO-5362 identifiers.
// Consumer expects a bare array `items`; producer returns `{ rows: Row[] }`.
// Identifier names differ on purpose to prove generalization beyond
// the fixture-specific `data`/`deleters` pair.

import * as React from 'react';

export interface RowListProps {
  items: Array<{ id: string; label: string }>;
}

export function RowList(props: RowListProps): JSX.Element {
  const { items } = props;
  return (
    <ul>
      {items.map((it) => (
        <li key={it.id}>{it.label}</li>
      ))}
    </ul>
  );
}

export default RowList;
