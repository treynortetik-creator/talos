// Navigation that degrades to a no-op outside a router, so a screen can render in isolation (shell tests, previews).
// The shell always mounts these inside its router; `useNavigate` itself throws without one.
import type { ReactNode } from 'react'
import { type NavigateFunction, useInRouterContext, useNavigate } from 'react-router'

const noop = (() => {}) as unknown as NavigateFunction

function Routed({ children }: { children: (navigate: NavigateFunction) => ReactNode }) {
  return children(useNavigate())
}

export function NavScope({ children }: { children: (navigate: NavigateFunction) => ReactNode }) {
  return useInRouterContext() ? <Routed>{children}</Routed> : children(noop)
}
