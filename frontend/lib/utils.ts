// cn(): the standard shadcn class merge helper — combines clsx (conditional
// classnames) with tailwind-merge (de-duplicates conflicting Tailwind classes).
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
