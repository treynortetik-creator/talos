// Where the app catalog and its helper state live: $TALOS_APP_HOME/apps. Directories 0700, files 0600 (M4.10).
import { join } from 'node:path'

export function appPaths(home: string) {
  const dir = join(home, 'apps')
  return {
    dir,
    catalog: join(dir, 'catalog.json'),
    resources: join(dir, 'resources'),
    captures: join(dir, 'captures'),
    pending: join(dir, 'pending'),
    claimed: join(dir, 'claimed'),
    scanLog: join(dir, 'scan.log'),
    liveVersion: join(dir, 'live-cc-version'),
  }
}
export type AppPaths = ReturnType<typeof appPaths>
