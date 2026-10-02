// Thumbnails: render the preview in a 1024x768 virtual viewport, then scale it down to fit the card width.
// Scripts are disabled in thumbnails (sandbox=""): model-generated pages with heavy JS or animation loops
// would otherwise all run on the page's main thread and can freeze the whole showcase. The large viewer still runs scripts.
// Only cards near the viewport keep a live iframe; cards scrolled far away are unloaded again.
const VIRTUAL_WIDTH = 1024

const resize = new ResizeObserver((entries) => {
  for (const e of entries) e.target.style.setProperty('--s', (e.contentRect.width / VIRTUAL_WIDTH).toFixed(4))
})

const lazy = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) mount(e.target)
      else unmount(e.target)
    }
  },
  { rootMargin: '300px 0px' }
)

function mount(thumb) {
  if (thumb.querySelector('iframe')) return
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', '')
  frame.setAttribute('tabindex', '-1')
  frame.setAttribute('aria-hidden', 'true')
  frame.setAttribute('scrolling', 'no')
  frame.title = thumb.dataset.title || '预览'
  frame.addEventListener('load', () => thumb.classList.add('loaded'), { once: true })
  frame.src = thumb.dataset.src
  thumb.append(frame)
}

function unmount(thumb) {
  thumb.querySelector('iframe')?.remove()
  thumb.classList.remove('loaded')
}

export function observeThumb(thumb) {
  resize.observe(thumb)
  if (thumb.dataset.src) lazy.observe(thumb)
}

export function resetThumbs() {
  resize.disconnect()
  lazy.disconnect()
}
