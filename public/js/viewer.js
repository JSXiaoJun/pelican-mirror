import { h, effortLabel, seconds, formatTime } from './format.js'

// Large preview dialog. entries: [{ group, item }], supports arrow-key and button navigation between items
export function createViewer(dialog) {
  const body = dialog.querySelector('.viewer-body')
  const title = dialog.querySelector('.viewer-title')
  const meta = dialog.querySelector('.viewer-meta')
  const count = dialog.querySelector('.viewer-count')
  const prev = dialog.querySelector('[data-act=prev]')
  const next = dialog.querySelector('[data-act=next]')
  const open = dialog.querySelector('[data-act=open]')
  let list = []
  let index = 0

  function render() {
    const { group, item } = list[index]
    const src = `/api/items/${item.id}/content`
    title.textContent = group.name
    meta.replaceChildren(
      h('span', { class: 'model' }, item.model),
      h('span', {}, `思考强度 ${effortLabel(item.effort)}`),
      h('span', {}, `耗时 ${seconds(item.latencyMs)}`),
      h('span', {}, formatTime(item.generatedAt))
    )
    body.replaceChildren(
      item.hasContent
        ? h('iframe', { class: 'viewer-frame', src, sandbox: 'allow-scripts', title: `${group.name} · ${item.model} 预览` })
        : h('div', { class: 'viewer-empty' }, '这一张暂无预览')
    )
    open.hidden = !item.hasContent
    open.href = src
    prev.disabled = index === 0
    next.disabled = index === list.length - 1
    count.textContent = `${index + 1} / ${list.length}`
  }

  const go = (delta) => {
    const target = index + delta
    if (target < 0 || target >= list.length) return
    index = target
    render()
  }

  prev.addEventListener('click', () => go(-1))
  next.addEventListener('click', () => go(1))
  dialog.querySelector('[data-act=close]').addEventListener('click', () => dialog.close())
  // Content fills the dialog, so a click whose target is the dialog itself came from the backdrop
  dialog.addEventListener('click', (e) => e.target === dialog && dialog.close())
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') go(-1)
    else if (e.key === 'ArrowRight') go(1)
  })
  dialog.addEventListener('close', () => body.replaceChildren())

  return {
    open(entries, i) {
      list = entries
      index = i
      render()
      if (!dialog.open) dialog.showModal()
    }
  }
}
