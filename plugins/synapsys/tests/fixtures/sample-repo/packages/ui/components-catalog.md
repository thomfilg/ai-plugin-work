# UI Components Catalog

This is a sample-repo fixture mirroring the real `packages/ui/components-catalog.md`
shape used by the synapsys-consolidate ui-catalog profile tests.

## Primitives

### Button

**Purpose**: Standard interactive button primitive for forms and actions.
**Use Cases**: Form submission, dialog confirmation, toolbar actions.
**Features**: Variants (primary/secondary/ghost), loading state, icon support.
**Location**: `packages/ui/src/primitives/Button.tsx`
**Docs**: `packages/ui/docs/Button.md`

### DataGrid

**Purpose**: High-density tabular data display with sorting, filtering, and virtualization.
**Use Cases**: Admin tables, report views, large dataset exploration.
**Features**: Column resize, row selection, server-side pagination, MUI-backed.
**Location**: `packages/ui/src/data/DataGrid.tsx`
**Docs**: `packages/ui/docs/DataGrid.md`

## Typography

### Text

**Purpose**: Inline text element with theme-aware color and weight.
**Use Cases**: Body copy, inline labels, captions.
**Features**: Variant prop, truncation, color tokens.
**Location**: `packages/ui/src/typography/Text.tsx`
**Docs**: `packages/ui/docs/Text.md`

### Heading

**Purpose**: Semantic heading element (h1-h6) with consistent scale.
**Use Cases**: Page titles, section headers, card headers.
**Features**: Level prop, responsive sizing, anchor support.
**Location**: `packages/ui/src/typography/Heading.tsx`
**Docs**: `packages/ui/docs/Heading.md`

### Paragraph

**Purpose**: Block-level paragraph with consistent vertical rhythm.
**Use Cases**: Long-form prose, descriptions, help text.
**Features**: Lead variant, dropcap, theme spacing.
**Location**: `packages/ui/src/typography/Paragraph.tsx`
**Docs**: `packages/ui/docs/Paragraph.md`

## Synthetic Collision Components

These two components are intentionally distinct primitives that both map to the same
raw-HTML tag, used by Task 6's unknown-collision warning test.

### Alpha

**Purpose**: Synthetic component A that collides with Beta on the same raw HTML tag.
**Use Cases**: Test-only — drives the unknown-collision stdout warning path.
**Features**: None (test fixture).
**Location**: `packages/ui/src/synthetic/Alpha.tsx`
**Docs**: `packages/ui/docs/Alpha.md`

### Beta

**Purpose**: Synthetic component B that collides with Alpha on the same raw HTML tag.
**Use Cases**: Test-only — drives the unknown-collision stdout warning path.
**Features**: None (test fixture).
**Location**: `packages/ui/src/synthetic/Beta.tsx`
**Docs**: `packages/ui/docs/Beta.md`
