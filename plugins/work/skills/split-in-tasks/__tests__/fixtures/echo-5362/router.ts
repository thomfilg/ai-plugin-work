// Fixture stub for ECHO-5362 Pass B regression.
// Producer side: returns `{ deleters: [...] }` — the consumer
// (deleter-select-field.tsx) instead expects an array directly.

export interface Deleter {
  id: string;
  label: string;
}

export interface GetDeletersResult {
  deleters: Deleter[];
}

export function getDeleters(): GetDeletersResult {
  return {
    deleters: [
      { id: 'd1', label: 'Deleter One' },
      { id: 'd2', label: 'Deleter Two' },
    ],
  };
}
