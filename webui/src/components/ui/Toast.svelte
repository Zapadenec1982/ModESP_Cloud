<script>
  import Icon from './Icon.svelte'

  export let type = 'info' // success | error | warning | info
  export let message = ''
  export let onClose

  const iconMap = {
    success: 'check-circle',
    error:   'x-circle',
    warning: 'alert-triangle',
    info:    'info',
  }
</script>

<div class="toast toast-{type}" role="alert">
  <Icon name={iconMap[type]} size={18} />
  <span class="msg">{message}</span>
  <button class="close" on:click={onClose} aria-label="Close">
    <Icon name="x" size={14} />
  </button>
</div>

<style>
  .toast {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    border: 1px solid;
    animation: slide-in-right 0.2s ease-out;
    min-width: 280px;
    max-width: 420px;
    box-shadow: var(--shadow-lg);
    font-size: var(--text-base);
  }

  .toast-success {
    background: #0d2818;
    border-color: var(--accent-green);
    color: var(--accent-green);
  }
  .toast-error {
    background: #2d1215;
    border-color: var(--accent-red);
    color: var(--accent-red);
  }
  .toast-warning {
    background: #2d2006;
    border-color: var(--accent-yellow);
    color: var(--accent-yellow);
  }
  .toast-info {
    background: #0d1d30;
    border-color: var(--accent-blue);
    color: var(--accent-blue);
  }

  .msg {
    flex: 1;
    color: var(--text-primary);
  }

  .close {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 2px;
    display: flex;
    opacity: 0.6;
  }
  .close:hover { opacity: 1; }

  @keyframes slide-in-right {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
</style>
