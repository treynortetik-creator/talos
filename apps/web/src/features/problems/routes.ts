// The screens a person passed through, by NAME, for the "steps" of a report. A path can hold a thread id or a card id, so
// only the first segment is looked at, and only when it is one of the screens we ship; anything else is `other`.

import { PROBLEM_LIMITS } from '@talos-app/protocol'
import { useEffect } from 'react'
import { useLocation } from 'react-router'

const KNOWN = new Set([
  'threads',
  't',
  'card',
  'open',
  'schedules',
  'settings',
  'search',
  'memory',
  'drive',
  'share',
  'help',
  'login',
  'enroll',
])
const NAMES: Record<string, string> = { t: 'thread', open: 'notification link' }

export function routeName(pathname: string): string {
  const seg = pathname.split('/').filter(Boolean)[0]
  if (seg === undefined) return 'home'
  if (!KNOWN.has(seg)) return 'other'
  const second = pathname.split('/').filter(Boolean)[1]
  if (seg === 'settings' && second && /^[a-z-]{1,20}$/.test(second) && KNOWN_SETTINGS.has(second))
    return `settings/${second}`
  return NAMES[seg] ?? seg
}

const KNOWN_SETTINGS = new Set(['health', 'integrations', 'devices', 'agent', 'notifications', 'voice', 'security'])

const trail: string[] = []

export function noteRoute(pathname: string): void {
  const name = routeName(pathname)
  if (trail[trail.length - 1] === name) return
  trail.push(name)
  while (trail.length > PROBLEM_LIMITS.routes) trail.shift()
}

export function routeTrail(): string[] {
  return [...trail]
}

/** Renders nothing; keeps the trail current. Mounted once inside the router. */
export function RouteTracker(): null {
  const { pathname } = useLocation()
  useEffect(() => noteRoute(pathname), [pathname])
  return null
}
