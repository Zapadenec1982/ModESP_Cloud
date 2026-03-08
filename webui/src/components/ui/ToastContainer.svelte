<script>
  import { toasts } from '../../lib/toast.js'
  import { toast } from '../../lib/toast.js'
  import Toast from './Toast.svelte'
</script>

{#if $toasts.length > 0}
  <div class="toast-container">
    {#each $toasts as t (t.id)}
      <Toast type={t.type} message={t.message} onClose={() => toast.remove(t.id)} />
    {/each}
  </div>
{/if}

<style>
  .toast-container {
    position: fixed;
    top: var(--space-4);
    right: var(--space-4);
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
</style>
