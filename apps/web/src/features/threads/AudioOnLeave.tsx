// Leaving the screen a clip was started on. A clip that has live system controls (the lock screen, Control Center, media keys or a
// watch, through the Media Session API or the iPhone shell's TalosAudio) keeps playing: he can stop it there. Where those controls
// are not available nothing could stop it, so it stops on leaving, as the audio route goes back. Moving inside one thread (a sheet
// over it, a card of it, a different query string) never counts, and neither does scrolling.
import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router'
import { audioPlayer, controlsActive, isTransientPath, screenOf } from './audioPlayer.ts'

export function AudioOnLeave() {
  const { pathname } = useLocation()
  const screen = screenOf(pathname)
  const was = useRef(screen)
  useEffect(() => {
    // /card/:id shows a thread and /open/:ref redirects to one: neither is a screen of its own, so they never stop a clip
    if (isTransientPath(pathname)) return
    if (was.current !== screen && !controlsActive()) audioPlayer.stop()
    was.current = screen
  }, [pathname, screen])
  return null
}
