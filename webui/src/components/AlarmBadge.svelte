<script>
  export let active = false;
  export let count = 0;
</script>

{#if active || count > 0}
  <span class="badge" class:critical={active}>
    {#if count > 0}
      {count}
    {:else}
      !
    {/if}
  </span>
{/if}

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    height: 22px;
    padding: 0 6px;
    border-radius: 11px;
    font-size: 0.75rem;
    font-weight: 700;
    background: #fdcb6e;
    color: #2d3436;
  }

  .badge.critical {
    background: #e17055;
    color: white;
  }
</style>
