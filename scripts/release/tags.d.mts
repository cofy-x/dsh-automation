export type ReleaseTagOperation =
  | { action: 'add'; tag: string; version: string }
  | { action: 'remove'; tag: string }

export function planReleaseTags(
  version: string,
  versions: string[],
  tags: Record<string, string>,
): ReleaseTagOperation[]

export function reconcileReleaseTags(version?: string): Promise<void>
