<script>
  import { effectiveTheme, toggleTheme } from '../../lib/theme.js'
  import { locale, setLocale, supportedLocales } from '../../lib/i18n.js'
  import Icon from '../ui/Icon.svelte'

  export let compact = false
</script>

<div class="settings-menu" class:compact>
  <!-- Theme toggle -->
  <button
    class="settings-btn"
    on:click={toggleTheme}
    title={$effectiveTheme === 'dark' ? 'Light theme' : 'Dark theme'}
    aria-label="Toggle theme"
  >
    <Icon name={$effectiveTheme === 'dark' ? 'sun' : 'moon'} size={15} />
  </button>

  <!-- Language selector -->
  {#if !compact}
    <div class="lang-group">
      {#each supportedLocales as loc}
        <button
          class="lang-btn"
          class:active={$locale === loc.code}
          on:click={() => setLocale(loc.code)}
          aria-label="Switch to {loc.label}"
        >
          {loc.label}
        </button>
      {/each}
    </div>
  {:else}
    <button
      class="settings-btn"
      on:click={() => setLocale($locale === 'uk' ? 'en' : 'uk')}
      title="Language: {$locale.toUpperCase()}"
      aria-label="Toggle language"
    >
      <span class="lang-icon">{$locale === 'uk' ? 'UA' : 'EN'}</span>
    </button>
  {/if}
</div>

<style>
  .settings-menu {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) 0;
  }

  .settings-menu.compact {
    flex-direction: column;
    align-items: center;
  }

  .settings-btn {
    background: none;
    border: 1px solid transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: 5px;
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all var(--transition-fast);
  }

  .settings-btn:hover {
    color: var(--text-secondary);
    background: var(--bg-tertiary);
    border-color: var(--border-muted);
  }

  .lang-group {
    display: flex;
    gap: 2px;
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
    padding: 2px;
  }

  .lang-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 2px 8px;
    border-radius: 3px;
    font-size: var(--text-xs);
    font-weight: 600;
    font-family: var(--font-sans);
    letter-spacing: 0.03em;
    transition: all var(--transition-fast);
  }

  .lang-btn:hover {
    color: var(--text-secondary);
  }

  .lang-btn.active {
    background: var(--accent-blue);
    color: #fff;
  }

  .lang-icon {
    font-size: var(--text-xs);
    font-weight: 700;
    letter-spacing: 0.03em;
  }
</style>
