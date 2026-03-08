<script>
  import { icons } from '../../lib/icons.js'

  export let name
  export let size = 18
  export let color = 'currentColor'

  $: svgContent = icons[name] || ''
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  style="color: {color}; flex-shrink: 0;"
  aria-hidden="true"
>
  {@html svgContent}
</svg>
