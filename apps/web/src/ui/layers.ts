// One layer for everything that opens over the page: sheets, dialogs, popovers and the menus built on them. Among
// themselves the one opened last is on top (each is a portal at the end of the body). Above the page's own floating
// controls (z-10: the usage chip in the header's corner, overlays on cards and frames) and the drop zone (z-30), so none
// of those ever draws over a sheet's corner or its close button; level with the floating bars (undo: z-40),
// where the newer one is on top; below toasts and full-screen viewers (z-50).
export const OVERLAY_LAYER = 'z-40'
