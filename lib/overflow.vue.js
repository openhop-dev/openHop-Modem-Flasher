import { ref, onMounted, onBeforeUnmount, nextTick } from './vue.prod.min.js?v=openhop13';

// Inject styles once (no scoped styles without a build step)
const STYLE_ID = 'read-more-styles'
if (!document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .rm-content {
      overflow: hidden;
      position: relative;
      transition: max-height 0.3s ease;
    }
    .rm-content.is-clamped::after {
      content: "";
      position: absolute;
      inset: auto 0 0 0;
      height: 40px;
      background: linear-gradient(transparent, var(--bg, #1c1b1e));
      pointer-events: none;
    }
    .read-more > button {
      margin: 5px 0 0 0;
      padding: 0;

    }
    .read-more > button:hover {
      background: transparent;
      text-decoration: underline;
    }
    .read-more > button::after {
      display: none;
    }
  `
  document.head.appendChild(style)
}

export default {
  name: 'ReadMore',
  props: {
    maxHeight: { type: String, default: '100px' },
    moreLabel: { type: String, default: 'Read more' },
    lessLabel: { type: String, default: 'Show less' },
  },
  setup(props) {
    const content = ref(null)
    const expanded = ref(false)
    const isOverflowing = ref(false)
    let observer = null

    function checkOverflow() {
      const el = content.value
      if (!el) return
      if (expanded.value) {
        isOverflowing.value = true
        return
      }
      isOverflowing.value = el.scrollHeight > el.clientHeight
    }

    function toggle() {
      expanded.value = !expanded.value
    }

    onMounted(async () => {
      await nextTick()
      checkOverflow()
      observer = new ResizeObserver(checkOverflow)
      observer.observe(content.value)
    })

    onBeforeUnmount(() => {
      observer?.disconnect()
    })

    return { content, expanded, isOverflowing, toggle }
  },
  template: `
    <div class="read-more">
      <div
        ref="content"
        class="rm-content"
        :class="{ 'is-expanded': expanded, 'is-clamped': isOverflowing && !expanded }"
        :style="{ maxHeight: expanded ? 'none' : maxHeight }"
      >
        <slot />
      </div>
      <button
        v-if="isOverflowing"
        type="button"
        class="small transparent"
        @click="toggle"
      >
        {{ expanded ? lessLabel : moreLabel }}
      </button>
    </div>
  `,
}