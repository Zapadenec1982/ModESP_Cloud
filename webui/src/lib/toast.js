import { writable } from 'svelte/store'

/** @type {import('svelte/store').Writable<Array<{id: number, type: string, message: string}>>} */
export const toasts = writable([])

let nextId = 0

function add(type, message, duration = 4000) {
  const id = nextId++
  toasts.update(t => [...t.slice(-2), { id, type, message }]) // max 3
  if (duration > 0) {
    setTimeout(() => remove(id), duration)
  }
  return id
}

function remove(id) {
  toasts.update(t => t.filter(x => x.id !== id))
}

export const toast = {
  success: (msg, duration = 4000) => add('success', msg, duration),
  error:   (msg, duration = 6000) => add('error', msg, duration),
  warning: (msg, duration = 5000) => add('warning', msg, duration),
  info:    (msg, duration = 4000) => add('info', msg, duration),
  remove,
}
