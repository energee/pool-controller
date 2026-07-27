// Raw frames card: a Disclosure (native <details>), the same idiom as the
// Diagnostics wrapper around it.
import { CFI_NAMES } from "../../lib/constants";
import { Disclosure, Muted } from "../primitives";

export function RawCard({ raw }: { raw?: Record<string, string> }) {
  const map = raw || {};
  const keys = Object.keys(map).sort((a, b) => Number(a) - Number(b));

  return (
    <Disclosure title={`Raw frames · ${keys.length}`} className="col-span-full">
      <div className="pt-1.5">
        {!keys.length ? (
          <Muted>none captured yet</Muted>
        ) : (
          <table className="w-full border-collapse text-xs">
            <tbody>
              {keys.map((cfi) => {
                const name = CFI_NAMES[Number(cfi)] || "CFI " + cfi;
                return (
                  <tr key={cfi}>
                    <td className="py-1.5 px-2 align-top">
                      {cfi}
                      <br />
                      <span className="text-muted-foreground">{name}</span>
                    </td>
                    <td className="py-1.5 px-2 align-top font-mono text-muted-foreground break-all">
                      {map[cfi]}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Disclosure>
  );
}
