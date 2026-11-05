// Inline 24px stroke icons. Every icon button that uses one carries an aria-label.
import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement>

function Icon({ d, ...props }: P & { d: string }) {
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={d} />
    </svg>
  )
}

export const IconBack = (p: P) => <Icon d={'M15 18l-6-6 6-6'} {...p} />
export const IconArrowDown = (p: P) => <Icon d={'M12 5v14M6 13l6 6 6-6'} {...p} />
export const IconShare = (p: P) => (
  <Icon d={'M12 15V3M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1'} {...p} />
)
export const IconPlus = (p: P) => <Icon d={'M12 5v14M5 12h14'} {...p} />
export const IconMic = (p: P) => (
  <Icon d={'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3'} {...p} />
)
/** A text cursor with sound lines coming off it: speak and the words appear in the box. Not the voice note mic, not the call's bars. */
export const IconDictate = (p: P) => (
  <Icon d={'M7 5h4M9 5v14M7 19h4M14 9.5a3.5 3.5 0 0 1 0 5M17.5 7a7 7 0 0 1 0 10'} {...p} />
)
export const IconStop = (p: P) => <Icon d={'M7 7h10v10H7z'} {...p} />
export const IconSend = (p: P) => <Icon d={'M5 12l14-7-5 14-2-6-7-1z'} {...p} />
export const IconMore = (p: P) => <Icon d={'M5 12h.01M12 12h.01M19 12h.01'} {...p} />
export const IconPlay = (p: P) => <Icon d={'M7 5l11 7-11 7z'} {...p} />
export const IconPause = (p: P) => <Icon d={'M8 5v14M16 5v14'} {...p} />
export const IconClock = (p: P) => <Icon d={'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z'} {...p} />
export const IconCopy = (p: P) => <Icon d={'M9 9h11v11H9zM5 15V4h11'} {...p} />
export const IconCheck = (p: P) => <Icon d={'M5 12l5 5 9-10'} {...p} />
export const IconChecks = (p: P) => <Icon d={'M2 12l5 5 8-9M12 15l2 2 8-9'} {...p} />
export const IconThreads = (p: P) => <Icon d={'M5 6h14M5 12h14M5 18h9'} {...p} />
export const IconBell = (p: P) => <Icon d={'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0'} {...p} />
export const IconSettings = (p: P) => (
  <Icon
    d={
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1c.6.5 1.3.9 2 1.2L10 21h4l.5-2.6c.7-.3 1.4-.7 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z'
    }
    {...p}
  />
)
export const IconExpand = (p: P) => <Icon d={'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'} {...p} />
export const IconClose = (p: P) => <Icon d={'M6 6l12 12M18 6L6 18'} {...p} />
export const IconImage = (p: P) => <Icon d={'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9h.01'} {...p} />
export const IconFile = (p: P) => <Icon d={'M7 3h7l5 5v13H7zM14 3v5h5'} {...p} />
export const IconCamera = (p: P) => <Icon d={'M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'} {...p} />
export const IconTrash = (p: P) => <Icon d={'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13'} {...p} />
export const IconAlert = (p: P) => <Icon d={'M12 4l9 16H3zM12 10v4M12 17h.01'} {...p} />
export const IconMail = (p: P) => <Icon d={'M4 6h16v12H4zM4 7l8 6 8-6'} {...p} />
export const IconChat = (p: P) => <Icon d={'M5 5h14v10H10l-4 4v-4H5z'} {...p} />
export const IconRocket = (p: P) => (
  <Icon d={'M12 3c3 2 5 5 5 9l-2 4H9l-2-4c0-4 2-7 5-9zM12 10h.01M9 16l-2 4M15 16l2 4M12 16v5'} {...p} />
)
export const IconMegaphone = (p: P) => <Icon d={'M4 10v4h3l8 4V6L7 10zM18 9a4 4 0 0 1 0 6M7 14l1 5h2l-1-5'} {...p} />
export const IconCardPay = (p: P) => <Icon d={'M3 6h18v12H3zM3 10h18M7 15h4'} {...p} />
export const IconScale = (p: P) => (
  <Icon d={'M12 4v16M8 20h8M5 7h14M5 7l-3 6a3 3 0 0 0 6 0zM19 7l-3 6a3 3 0 0 0 6 0z'} {...p} />
)
export const IconDiamond = (p: P) => <Icon d={'M12 3l8 9-8 9-8-9z'} {...p} />
export const IconPencil = (p: P) => <Icon d={'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4'} {...p} />
export const IconSidebar = (p: P) => <Icon d={'M4 5h16v14H4zM9 5v14'} {...p} />
export const IconChevron = (p: P) => <Icon d={'M9 6l6 6-6 6'} {...p} />
export const IconClip = (p: P) => (
  <Icon d={'M20 11l-8 8a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7'} {...p} />
)
export const IconUser = (p: P) => <Icon d={'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0'} {...p} />
export const IconPlug = (p: P) => <Icon d={'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4'} {...p} />
export const IconLink = (p: P) => (
  <Icon d={'M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1'} {...p} />
)
export const IconSun = (p: P) => (
  <Icon
    d={
      'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'
    }
    {...p}
  />
)
export const IconSearch = (p: P) => <Icon d={'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4'} {...p} />
export const IconTerminal = (p: P) => <Icon d={'M4 5h16v14H4zM8 10l3 2-3 2M13 15h4'} {...p} />
export const IconBook = (p: P) => <Icon d={'M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10'} {...p} />
