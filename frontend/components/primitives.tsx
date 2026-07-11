// Shared presentational primitives ported from the former dom.ts string builders
// (row/tile/stat/card). These are pure layout — no data fetching here.
import * as React from "react";

import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
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
    <div className="flex justify-between gap-2.5 py-[7px] border-t border-border first:border-t-0">
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
    <div className="rounded-md border border-border bg-popover px-3 py-2.5">
      <div className="text-[11px] text-muted-foreground">{k}</div>
      <div className="text-xl font-medium mt-0.5 tracking-tight">
        {children}
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

// A dashboard card with the uppercase muted title and optional experimental tag.
export function DashCard({
  title,
  experimental,
  className,
  children,
}: {
  title: string;
  experimental?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={cn("transition-colors hover:border-border", className)}>
      <CardHeader>
        <CardTitle>
          {title}
          {experimental ? <ExperimentalBadge /> : null}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
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
    <div className={cn("grid grid-cols-2 gap-2.5", className)}>{children}</div>
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
