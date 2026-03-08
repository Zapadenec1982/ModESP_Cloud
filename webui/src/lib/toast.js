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
  success: (msg) => add('success', msg),
  error:   (msg) => add('error', msg, 6000),
  warning: (msg) => add('warning', msg, 5000),
  info:    (msg) => add('info', msg),
  remove,
}
