<script>
  /**
   * Own home base — the self-service half of Part 2 §7.4.
   *
   * `GET /api/sites/:id/nearest-technicians` ranks staff by the distance from
   * this point, so the technician it ranks needs a way to set and correct it
   * themselves. The admin half lives on Users.svelte and writes through
   * `PUT /api/users/:id`, which sits behind `authorize('admin')` and therefore
   * 403s the very roles that need this — hence the separate /api/profile router.
   *
   * Latitude and longitude are always written (or cleared) together: the backend
   * rejects a half-set pair, and a half-set base would put the technician on the
   * prime meridian.
   */
  import { createEventDispatcher } from 'svelte'
  import { getProfile, updateProfile } from '../../lib/api.js'
  import { t } from '../../lib/i18n.js'
  import { toast } from '../../lib/toast.js'
  import Icon from '../ui/Icon.svelte'
  import Skeleton from '../ui/Skeleton.svelte'

  export let show = false

  const dispatch = createEventDispatcher()

  let point = null      // { latitude, longitude, display_name } — AddressPicker mode="point"
  let loading = false
  let saving = false
  let loadedFor = null  // guards the reactive loader against re-firing per keystroke

  $: if (show && loadedFor !== 'open') { loadedFor = 'open'; loadProfile() }
  $: if (!show && loadedFor !== null) { loadedFor = null }

  $: hasPoint = !!point
    && point.latitude !== null && point.latitude !== undefined && point.latitude !== ''
    && point.longitude !== null && point.longitude !== undefined && point.longitude !== ''

  async function loadProfile() {
    loading = true
    try {
      const profile = await getProfile()
      point = {
        latitude:  profile.base_latitude ?? null,
        longitude: profile.base_longitude ?? null,
        display_name: profile.base_address || '',
      }
    } catch (e) {
      toast.error(e.message)
      // An empty pin is still editable, so the modal stays usable after a failed
      // read rather than showing a permanently blank body.
      point = { latitude: null, longitude: null, display_name: '' }
    } finally {
      loading = false
    }
  }

  function close() {
    show = false
    point = null
    dispatch('close')
  }

  function handleKeydown(e) {
    if (e.key === 'Escape') close()
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) close()
  }

  async function save() {
    if (!hasPoint) {
      toast.warning($t('users.base_needs_point'))
      return
    }
    saving = true
    try {
      const address = (point.display_name || '').trim()
      await updateProfile({
        base_latitude:  Number(point.latitude),
        base_longitude: Number(point.longitude),
        base_address:   address ? address.slice(0, 256) : null,
      })
      toast.success($t('users.base_saved'))
      close()
    } catch (e) {
      toast.error(e.message)
    } finally {
      saving = false
    }
  }

  async function clear() {
    saving = true
    try {
      await updateProfile({ base_latitude: null, base_longitude: null, base_address: null })
      toast.success($t('users.base_cleared'))
      close()
    } catch (e) {
      toast.error(e.message)
    } finally {
      saving = false
    }
  }
</script>

{#if show}
  <div class="modal-backdrop" role="presentation" on:click={handleBackdropClick} on:keydown={handleKeydown}>
    <div class="modal" role="dialog" aria-modal="true" aria-label={$t('users.base_location_title')}>
      <div class="modal-header">
        <h2>{$t('users.base_location_title')}</h2>
        <button class="modal-close" on:click={close} aria-label={$t('common.close')}>
          <Icon name="x" size={18} />
        </button>
      </div>

      <div class="modal-body">
        <p class="hint">{$t('users.base_location_hint')}</p>

        {#if loading || !point}
          <Skeleton height="300px" />
        {:else}
          <!--
            Lazily imported: AddressPicker pulls in MapCanvas and therefore
            Leaflet. A static import here would drag ~150 KB into the entry
            chunk that every user downloads on every page.
          -->
          {#await import('../map/AddressPicker.svelte')}
            <Skeleton height="300px" />
          {:then { default: AddressPicker }}
            <AddressPicker mode="point" bind:value={point} disabled={saving} height="240px" />
          {:catch}
            <p class="hint hint-error">{$t('users.base_picker_failed')}</p>
          {/await}
        {/if}
      </div>

      <div class="modal-actions">
        <!-- Disabled, not hidden, when there is nothing to clear: the button
             stays in the same place whether or not a base is set. -->
        <button class="btn btn-ghost" on:click={clear} disabled={saving || loading || !hasPoint}>
          {$t('users.clear_base')}
        </button>
        <button class="btn btn-ghost" on:click={close} disabled={saving}>
          {$t('common.cancel')}
        </button>
        <button class="btn btn-primary" on:click={save} disabled={saving || loading || !hasPoint}>
          {saving ? $t('common.loading') : $t('common.save')}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-overlay);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: var(--space-4);
  }

  .modal {
    background: var(--bg-secondary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    width: 100%;
    max-width: 560px;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: var(--shadow-lg);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4);
    border-bottom: 1px solid var(--border-muted);
  }

  .modal-header h2 {
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-primary);
  }

  .modal-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .modal-close:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .modal-body {
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .hint-error {
    color: var(--accent-red, #ef4444);
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--border-muted);
  }

  .btn {
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
    border: 1px solid transparent;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-ghost {
    background: transparent;
    color: var(--text-secondary);
    border-color: var(--border-default);
  }

  .btn-ghost:hover:not(:disabled) {
    background: var(--bg-tertiary);
  }

  .btn-primary {
    background: var(--accent-blue);
    color: #fff;
    border-color: var(--accent-blue);
  }

  .btn-primary:hover:not(:disabled) {
    filter: brightness(1.1);
  }
</style>
