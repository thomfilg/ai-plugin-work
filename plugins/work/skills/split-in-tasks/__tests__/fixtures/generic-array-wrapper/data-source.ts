// Generic Pass B regression fixture — producer side.
// Returns `{ rows: Row[] }` — a wrapper object containing an array
// field. Diverges from the consumer (row-list.tsx) which expects a
// bare array prop.

export interface Row {
  id: string;
  label: string;
}

export interface GetRowsResult {
  rows: Row[];
}

export function getRows(): GetRowsResult {
  return {
    rows: [
      { id: 'r1', label: 'Row One' },
      { id: 'r2', label: 'Row Two' },
    ],
  };
}
