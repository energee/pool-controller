// Raw frames card: a collapsed <details>-equivalent. Open/closed state is held in
// component state so it persists across the 3s re-render (the former store.rawOpen).
import * as React from "react";

import { CFI_NAMES } from "../../lib/constants";
import { cn } from "../../lib/utils";
import { Muted } from "../primitives";

export function RawCard({ raw }: { raw?: Record<string, string> }) {
  const [open, setOpen] = React.useState(false);
  const map = raw || {};
  const keys = Object.keys(map).sort((a, b) => Number(a) - Number(b));

  return (
    <div className="rounded-lg border border-border bg-card col-span-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-4 py-3.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground cursor-pointer"
      >
        Raw frames · {keys.length}
      </button>
      {open ? (
        <div
          className={cn(
            "px-4 pb-3.5 pt-1.5 border-t border-border"
          )}
        >
          {!keys.length ? (
            <Muted>none captured yet</Muted>
          ) : (
            <table className="w-full border-collapse text-xs">
              <tbody>
                {keys.map((cfi) => {
                  const name = CFI_NAMES[Number(cfi)] || "CFI " + cfi;
                  return (
                    <tr key={cfi}>
                      <td className="py-1.5 px-2 border-t border-border align-top">
                        {cfi}
                        <br />
                        <span className="text-muted-foreground">{name}</span>
                      </td>
                      <td className="py-1.5 px-2 border-t border-border align-top font-mono text-muted-foreground break-all">
                        {map[cfi]}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </div>
  );
}
