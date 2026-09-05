<script>
  // "Assign a work order" from an alarm or a maintenance hint (plan epic 2.3):
  // one dialog, prefilled from the source, with the assignee chosen right here.
  // An administrator picks anyone from the organisation; a technician can only
  // take the order themselves. Emits `created` with the new order and `close`.
  import { createEventDispatcher, onMount } from 'svelte'
  import { createWorkOrder, getWorkOrderAssignees } from '../lib/api.js'
  import { isAdmin, authUser } from '../lib/stores.js'
  import { alarmLabel } from '../lib/format.js'
  import { t } from '../lib/i18n.js'
  import { toast } from '../lib/toast.js'
  import Icon from './ui/Icon.svelte'
  import Button from './ui/Button.svelte'

  /** { kind: 'alarm' | 'hint', id, alarm_code, severity, device_id (uuid or mqtt id), device_name, title?, description? } */
  export let source

  const dispatch = createEventDispatcher()

  let assignees = []
  let saving = false
  let takeMyself = false
  let form = { title: '', description: '', priority: 'normal', assigned_to: '', scheduled_at: '' }

  function defaultTitle(s) {
    const what = s.title || (s.alarm_code ? alarmLabel(s.alarm_code) : '')
    return `${what} — ${s.device_name || s.device_id || ''}`.trim()
  }

  onMount(async () => {
    form = {
      title: defaultTitle(source),
      description: source.description || '',
      priority: source.severity === 'critical' ? 'high' : 'normal',
      assigned_to: '',
      scheduled_at: '',
    }
    if ($isAdmin) {
      try { assignees = await getWorkOrderAssignees() } catch { assignees = [] }
    }
  })

  async function save() {
    saving = true
    try {
      const body = { title: form.title.trim(), description: form.description || null, priority: form.priority, device_id: source.device_id }
      if (source.kind === 'alarm') body.alarm_id = source.id
      if (source.kind === 'hint')  body.hint_id  = source.id
      if ($isAdmin && form.assigned_to) body.assigned_to = form.assigned_to
      if (!$isAdmin && takeMyself && $authUser?.id) body.assigned_to = $authUser.id
      if (form.scheduled_at) body.scheduled_at = new Date(form.scheduled_at).toISOString()
      const order = await createWorkOrder(body)
      toast.success($t('wo.saved'))
      dispatch('created', order)
    } catch (e) {
      toast.error(e.message)
    } finally {
      saving = false
    }
  }
  function close() { if (!saving) dispatch('close') }
  function onKey(e) { if (e.key === 'Escape') close() }
</script>

<svelte:window on:keydown={onKey} />

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<div class="modal-backdrop" on:click={close}>
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="modal" role="dialog" aria-modal="true" on:click|stopPropagation>
    <div class="modal-header">
      <h2><Icon name="clipboard" size={18} /> {$t('alarm.create_wo')}</h2>
      <button class="modal-close" on:click={close} aria-label={$t('common.cancel')}><Icon name="x" size={18} /></button>
    </div>
    <div class="modal-body">
      <p class="source">
        {$t('wo.source')}: {source.kind === 'alarm' ? $t('wo.from_alarm') : $t('wo.from_hint')}
        {#if source.alarm_code} — <strong>{alarmLabel(source.alarm_code)}</strong>{/if}
        {#if source.device_name || source.device_id} · <span class="mono">{source.device_name || source.device_id}</span>{/if}
      </p>
      <div class="form-group"><label for="wom-title">{$t('wo.title')}</label><input id="wom-title" type="text" bind:value={form.title} maxlength="200" /></div>
      <div class="form-group"><label for="wom-desc">{$t('wo.description')}</label><textarea id="wom-desc" rows="2" bind:value={form.description}></textarea></div>
      <div class="form-row">
        <div class="form-group"><label for="wom-prio">{$t('wo.priority')}</label>
          <select id="wom-prio" bind:value={form.priority}>
            {#each ['low', 'normal', 'high', 'urgent'] as p}<option value={p}>{$t(`wo.prio_${p}`)}</option>{/each}
          </select></div>
        <div class="form-group"><label for="wom-when">{$t('wo.scheduled')}</label><input id="wom-when" type="datetime-local" bind:value={form.scheduled_at} /></div>
      </div>
      {#if $isAdmin}
        <div class="form-group"><label for="wom-who">{$t('wo.assignee')}</label>
          <select id="wom-who" bind:value={form.assigned_to}>
            <option value="">{$t('wo.unassigned')}</option>
            {#each assignees as u}<option value={u.id}>{u.email}</option>{/each}
          </select></div>
      {:else}
        <label class="check"><input type="checkbox" bind:checked={takeMyself} /> {$t('wo.take')}</label>
      {/if}
    </div>
    <div class="modal-actions">
      <Button variant="ghost" on:click={close} disabled={saving}>{$t('common.cancel')}</Button>
      <Button variant="primary" on:click={save} disabled={saving || !form.title.trim()}>
        {saving ? $t('common.loading') : (($isAdmin && form.assigned_to) || (!$isAdmin && takeMyself) ? $t('wo.assign') : $t('common.save'))}
      </Button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop { position: fixed; inset: 0; background: var(--bg-overlay); display: flex; align-items: center; justify-content: center; z-index: 100; padding: var(--space-4); }
  .modal { background: var(--bg-secondary); border: 1px solid var(--border-default); border-radius: var(--radius-lg); width: 100%; max-width: 520px; max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-lg); }
  .modal-header { display: flex; align-items: center; justify-content: space-between; padding: var(--space-4); border-bottom: 1px solid var(--border-muted); }
  .modal-header h2 { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-lg); font-weight: 600; margin: 0; }
  .modal-close { display: flex; width: 28px; height: 28px; align-items: center; justify-content: center; border: none; background: transparent; color: var(--text-muted); cursor: pointer; border-radius: var(--radius-sm); }
  .modal-body { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
  .modal-actions { display: flex; justify-content: flex-end; gap: var(--space-2); padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border-muted); }
  .source { margin: 0; font-size: var(--text-sm); color: var(--text-secondary); }
  .mono { font-family: var(--font-mono); }
  .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
  .form-group { display: flex; flex-direction: column; gap: var(--space-1); }
  .form-group label { font-size: var(--text-sm); font-weight: 500; color: var(--text-secondary); }
  .form-group input, .form-group textarea, .form-group select { padding: var(--space-2) var(--space-3); background: var(--bg-primary); border: 1px solid var(--border-default); border-radius: var(--radius-sm); color: var(--text-primary); font-size: var(--text-sm); font-family: inherit; }
  .form-group textarea { resize: vertical; }
  .check { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); color: var(--text-primary); }
  @media (max-width: 480px) { .form-row { grid-template-columns: 1fr; } }
</style>
