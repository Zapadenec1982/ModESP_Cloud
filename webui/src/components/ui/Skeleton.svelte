<script>
  export let width = '100%'
  export let height = '16px'
  export let rounded = false
</script>

<div
  class="skeleton"
  class:rounded
  style="width: {width}; height: {height};"
/>

<style>
  .skeleton {
    background: linear-gradient(90deg, var(--bg-tertiary) 25%, var(--border-default) 50%, var(--bg-tertiary) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.5s ease-in-out infinite;
    border-radius: var(--radius-sm);
  }
  .rounded {
    border-radius: var(--radius-full);
  }

  @keyframes shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
</style>
