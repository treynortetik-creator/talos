// The public descriptor a relay serves at GET /.well-known/talos-relay (BYOR: "bring your own relay"). The iPhone app reads it
// when the owner points it at a relay, to see which relay it is and whether this app is new enough.
//
// `min_app`: an older app does not connect and asks for an update (BYOR 3.1). It is not a security check: a hostile relay
// can say anything here, so nothing may trust a relay more because of what it says.
import { z } from 'zod'
import { compareSemver, SEMVER } from './semver.ts'
import { PROTOCOL_VERSION } from './version.ts'

export const RELAY_DESCRIPTOR_PATH = '/.well-known/talos-relay'

const fields = {
  protocol: z.number().int(),
  relay_version: z.string().max(64),
  relay_id: z.string().regex(/^r_[a-z2-7]{20}$/),
  kind: z.enum(['hosted', 'self']),
  min_app: z.string().regex(SEMVER),
}

/** What a relay sends: exactly these fields, `protocol` being the version this build speaks. */
export const RelayDescriptor = z.strictObject({ ...fields, protocol: z.literal(PROTOCOL_VERSION) })
export type RelayDescriptorT = z.infer<typeof RelayDescriptor>

/** What the app parses: extra fields are ignored (a newer relay may add some), and any protocol number reads. */
export const RelayDescriptorRead = z.object(fields)
export type RelayDescriptorReadT = z.infer<typeof RelayDescriptorRead>

/** True when the app is at least `min_app`; false for an app version that is not `x.y.z`. Advisory, see above. */
export function appMeetsMin(appVersion: string, d: { min_app: string }): boolean {
  const c = compareSemver(appVersion, d.min_app)
  return c !== null && c >= 0
}
