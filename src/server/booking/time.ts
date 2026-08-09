/** Hours between `now` and the given ISO timestamp. Negative once it's passed. */
export function hoursUntil(iso: string, now = new Date()): number {
  return (new Date(iso).getTime() - now.getTime()) / 36e5;
}
