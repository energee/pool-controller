// Shared presentational primitives ported from the former dom.ts string builders
// (row/tile/stat/card). These are pure layout — no data fetching here.
import * as React from "react";
import { Minus, Plus } from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

// A labelled key/value line with a hairline top border.
export function Row({
  k,
  children,
}: {
  k: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex justify-between gap-2.5 py-1">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-foreground text-right">{children}</span>
    </div>
  );
}

// A small stat tile (label over a big value) on the elevated surface.
export function Tile({
  k,
  children,
}: {
  k: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md bg-popover px-3 py-2.5">
      <div className="text-[11px] text-muted-foreground">{k}</div>
      <div className="text-xl font-medium mt-0.5 tracking-tight">
        {children}
      </div>
    </div>
  );
}

// The uppercase muted section-title style shared by card headings and the
// Diagnostics / Raw frames disclosures.
export const SECTION_TITLE =
  "text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground";

// The smaller uppercase label over a big stat value (setpoints, salt, output).
export const STAT_LABEL =
  "text-[11px] text-muted-foreground tracking-[0.04em] uppercase";

// A labelled big-value readout with −/+ stepper buttons — the app's shared
// "adjust a number" control (heat setpoints, chlorinator output). `value` is a
// ReactNode so callers render their own units and pending treatment; the
// buttons report direction only and callers apply their own step size.
export function Stepper({
  label,
  aria,
  value,
  onNudge,
}: {
  label: React.ReactNode;
  /** aria-label base for the buttons: "<aria> down" / "<aria> up". */
  aria: string;
  value: React.ReactNode;
  onNudge: (direction: 1 | -1) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div>
        <div className={STAT_LABEL}>{label}</div>
        <div className="text-[22px] font-medium tracking-tight">{value}</div>
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          className="h-9 w-11 px-0"
          aria-label={aria + " down"}
          onClick={() => onNudge(-1)}
        >
          <Minus />
        </Button>
        <Button
          variant="outline"
          className="h-9 w-11 px-0"
          aria-label={aria + " up"}
          onClick={() => onNudge(1)}
        >
          <Plus />
        </Button>
      </div>
    </div>
  );
}

// The "experimental" amber pill used on unverified cards/controls.
export function ExperimentalBadge() {
  return (
    <Badge variant="experimental" className="ml-2">
      experimental
    </Badge>
  );
}

// A native-<details> disclosure with the shared section-title summary (closed by
// default). Open/closed state lives in the DOM, so it survives the 3s re-render —
// React never touches the attribute after mount. Used directly (Diagnostics, Raw
// frames, Pump Speed) and by `DashCard collapsible`.
export function Disclosure({
  title,
  experimental,
  className,
  children,
}: {
  title: React.ReactNode;
  experimental?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <details className={className}>
      <summary
        className={cn(SECTION_TITLE, "cursor-pointer py-1 list-none hover:text-foreground")}
      >
        {title}
        {experimental ? <ExperimentalBadge /> : null} ▸
      </summary>
      {children}
    </details>
  );
}

// A dashboard card with the uppercase muted title and optional experimental tag.
// `collapsible` renders it as a `Disclosure` instead of a titled section.
export function DashCard({
  title,
  experimental,
  collapsible,
  className,
  children,
}: {
  title: string;
  experimental?: boolean;
  collapsible?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  // Flat section, not a boxed card: the uppercase title is the only separator.
  // Inner controls (tiles, switch rows, inputs) carry their own affordances.
  if (collapsible) {
    return (
      <Disclosure title={title} experimental={experimental} className={className}>
        {children}
      </Disclosure>
    );
  }
  return (
    <section className={className}>
      <h3 className={cn(SECTION_TITLE, "mb-2")}>
        {title}
        {experimental ? <ExperimentalBadge /> : null}
      </h3>
      {children}
    </section>
  );
}

// A two-column grid used throughout the cards.
export function Grid2({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("grid grid-cols-2 gap-2", className)}>{children}</div>
  );
}

export function Muted({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("text-muted-foreground", className)}>{children}</div>
  );
}
