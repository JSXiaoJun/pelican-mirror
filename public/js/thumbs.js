// Thumbnails: render the preview in a 1024x768 virtual viewport, then scale it down to fit the card width.
// The server's /thumb variant strips scripts and animations: dozens of live animated pages in one grid
// all repaint on the main thread and freeze the showcase. The large viewer still gets the live page.
// Only cards near the viewport keep an iframe; cards scrolled far away are unloaded again.
// Mounts go through a small queue so a screenful of iframes isn't parsed and laid out in one frame.
const VIRTUAL_WIDTH = 1024
const MAX_LOADING = 3

const resize = new ResizeObserver((entries) => {
  for (const e of entries) e.target.style.setProperty('--s', (e.contentRect.width / VIRTUAL_WIDTH).toFixed(4))
})

const queue = new Set()
let loading = 0

const lazy = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        queue.add(e.target)
      } else {
        queue.delete(e.target)
        unmount(e.target)
      }
    }
    pump()
  },
  { rootMargin: '300px 0px' }
)

function pump() {
  while (loading < MAX_LOADING && queue.size) {
    const thumb = queue.values().next().value
    queue.delete(thumb)
    mount(thumb)
  }
}

function settle(frame) {
  if (!frame.isConnected || frame.dataset.settled) return
  frame.dataset.settled = '1'
  loading--
  // Yield a frame between batches so scrolling and input stay responsive
  requestAnimationFrame(pump)
}

function mount(thumb) {
  if (thumb.querySelector('iframe')) return
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', '')
  frame.setAttribute('tabindex', '-1')
  frame.setAttribute('aria-hidden', 'true')
  frame.setAttribute('scrolling', 'no')
  frame.title = thumb.dataset.title || '预览'
  frame.addEventListener('load', () => {
    thumb.classList.add('loaded')
    settle(frame)
  }, { once: true })
  loading++
  frame.src = thumb.dataset.src
  thumb.append(frame)
  // A hung load must not block the queue forever
  setTimeout(() => settle(frame), 4000)
}

function unmount(thumb) {
  const frame = thumb.querySelector('iframe')
  if (!frame) return
  if (!frame.dataset.settled) {
    frame.dataset.settled = '1'
    loading--
  }
  frame.remove()
  thumb.classList.remove('loaded')
}

export function observeThumb(thumb) {
  resize.observe(thumb)
  if (thumb.dataset.src) lazy.observe(thumb)
}

export function resetThumbs() {
  resize.disconnect()
  lazy.disconnect()
  queue.clear()
  loading = 0
}
