// Fixture stub for ECHO-5362 Pass B regression.
// The contract-extractor (Task 4) should detect that this component
// consumes `data` as an array (it calls `data.map`), which diverges
// from the producer shape `{ deleters: [...] }` in router.ts.

import * as React from 'react';

export interface DeleterSelectFieldProps {
  data: Array<{ id: string; label: string }>;
}

export function DeleterSelectField(props: DeleterSelectFieldProps): JSX.Element {
  const { data } = props;
  // Consumer signature: expects an iterable with .map — diverges from {deleters:[...]}
  return (
    <select>
      {data.map((d) => (
        <option key={d.id} value={d.id}>
          {d.label}
        </option>
      ))}
    </select>
  );
}

export default DeleterSelectField;
